import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TENANT_A } from '@kasuwa/db';
import { stack } from './support/stack';
import { assertWithinByteBudget, measurePageLoad } from './support/metrics';
import { servedBuildId } from './support/critical-path';
import {
  A_PHARMACY,
  CURRENCIES,
  C_ALPHA,
  C_ALPHA_ELSEWHERE,
  C_BETA,
  D_BIG,
  D_C1,
  D_D1,
  D_D2,
  D_N2,
  D_P1,
  D_P2,
  D_P3,
  D_Q1,
  D_Q2,
  D_Q_MARKUP,
  D_Q_OTHER,
  E_P1,
  E_Q1,
  HOSTILE_NAME,
  ME,
  NOW,
  OTHER,
  PIPELINE_ONE,
  PIPELINE_TWO,
  PROGRAMME_ONE,
  PROGRAMME_TWO,
  R_AMOUNT,
  R_BUDGET,
  R_CLOSE,
  R_CONTACT,
  R_DRIFT,
  R_PO,
  R_QUOTE,
  S_CONTRACT,
  S_DISCOVERY,
  S_LOST,
  S_NEGOTIATION,
  S_PROPOSAL,
  S_QUALIFIED,
  S_WON,
  T_NEGOTIATION,
  T_PROPOSAL,
  T_R_QUOTE,
  WITHHOLDABLE_FIELDS,
  boardStages,
  installPipelineMock,
  weightedMinor,
  withheldIn,
  type PipelineMock,
  type StoredDeal,
} from './support/pipeline-mock';
import {
  FORMER_CHECKER,
  FORMER_MEMBER,
  ITEM_ACCOUNT,
  ITEM_AMOUNT,
  ITEM_CALL,
  ITEM_CONTACT,
  ITEM_MEETING,
  ITEM_NAME,
  ITEM_NEXT_STEP,
  ITEM_NOTE,
  ITEM_OWNER,
  ITEM_STAGE,
  ITEM_TASK,
  LONG_OLDEST_SUBJECT,
  LONG_TIMELINE_LENGTH,
  NEW_ACTIVITY_IDS,
  NO_SUCH_DEAL_ID,
  ORPHAN_REQUIREMENT_ID,
  OUT_OF_SCOPE_DEAL_ID,
  TIMELINE_DEFAULT_LIMIT,
  TIMELINE_FIELDS,
  X_FULL,
  X_LONG,
  X_MINE,
  dealAnswerProblems,
  detailDeals,
  installDealMock,
  isCreateActivity,
  isDealTimeline,
  isUpdateDeal,
  servedDealData,
  timelineOf,
  type DealMock,
  type DealMockOptions,
} from './support/deal-mock';

/**
 * T-0110 — the P06 deal detail (`docs/design/P06/`, frames P06/05 and the
 * 360 px P06/06), at `/deals/[dealId]`, behind `crm_pipeline`, in the CRM
 * shell, against T-0108's served getDeal, updateDeal and moveDeal and
 * T-0111's served listDealTimeline and createActivity with `dealId`. Written
 * by the lead's QA agent BEFORE the screen exists (D-L23);
 * `tests/acceptance/records-ui/deal-detail.acceptance.test.ts` runs this file
 * with `--grep @p06-deal` and reads every outcome by tag. Decisions: D-L88,
 * D-L102, D-L115, D-L124, D-L127, D-L129, D-L130, D-P23, D-L84, D-L63.
 *
 * TAG RULE (D-L84). `@p06-deal` is the parent tag; every sub-tag is
 * `@p06-deal-<name>`. Playwright's --grep is a regular expression: no other
 * screen's tag contains `@p06-deal`, and it contains no other screen's parent
 * tag (T-0109's pipeline tag included).
 *
 * ---------------------------------------------------------------------------
 * THE ROUTE AND THE WEB PROCESS (rulings R1–R3 in the acceptance suite)
 *
 *   /deals/<dealId>   the deal detail (P06/05; P06/06 at 360 px)
 *
 *   webUrl           — the default server, every flag at its default: a real
 *                      404 there.
 *   webPipelineUrl   — the records process with `crm_pipeline` on, published
 *                      by T-0109's builder. Every journey and the byte budget
 *                      run there, on the production build.
 *
 * EVERY READ AND WRITE GOES THROUGH THE CONTRACT MOCK
 *
 * Every journey installs `support/deal-mock.ts` (which imports T-0109's
 * `pipeline-mock.ts`), which serves the operations from the contract and
 * checks every answer it gives against it. `afterEach` fails a test in which
 * the screen sent anything the contract or this screen's rules do not allow
 * (the mock's header lists them), left the origin, or in which a mock
 * answered something its own contract rejects.
 *
 * THE CLOCK. Journeys fix the browser's clock to the mock's NOW (09:00 UTC,
 * Monday 12 October 2026); the byte-budget journeys do not (D-L118). The
 * zone is Lagos, except where a journey says otherwise.
 *
 * THE DOM HOOKS THIS FILE RELIES ON (the builder's side of the contract)
 *
 *   [data-shell="crm"]                       the CRM shell; its nav's Deals
 *     a[href="/pipelines"]                   entry is aria-current="page" here
 *   [data-screen="P06/05"]                   the deal root, carrying
 *     data-record-state="loading|ready"
 *   h1                                       the deal's name (record text)
 *   [data-testid="deal-breadcrumb"]          holding a[href="/pipelines/<pipelineId>"]
 *                                            that names the deal's pipeline
 *   [data-field="stage"]                     the current stage's name
 *   [data-testid="stage-path"]               role=list: [data-stage-step="<stage id>"]
 *                                            for every open stage then won,
 *                                            position order, never lost;
 *                                            aria-current="step" on the current
 *   [data-testid="stage-requirements"]       the CURRENT stage's requirements:
 *     [data-requirement="<requirement id>"]  data-met="true|false", or
 *                                            data-locked="true" when its field
 *                                            is withheld
 *   [data-field="amount"|"weightedAmount"|"expectedCloseDate"|"owner"|"nextStep"]
 *                                            the VALUE alone (its label, and
 *                                            any "(70%)", sits outside it);
 *                                            data-locked="true" when withheld;
 *                                            expectedCloseDate holds
 *                                            <time datetime="YYYY-MM-DD">
 *   [data-related="contact"|"account"]       the summary: a link to
 *                                            /contacts/<id> or /accounts/<id>
 *                                            for a well-formed uuid, else
 *                                            text; data-locked="true" when
 *                                            withheld
 *   [data-testid="deal-checks"]              one [data-check="<requirement id>"]
 *                                            per served check, served order,
 *     [data-checked-by]                      the checker's name, or the
 *                                            translated former-checker label
 *     <time datetime="<checkedAt>">
 *   [data-action="assign-to-me"]             only where offered (R11)
 *   [data-action="edit-deal"]                opens
 *   [data-testid="deal-sheet"]               role=dialog, with
 *     [data-field-input="name|amount|currency|expectedCloseDate|nextStep|primaryContactId|accountId"]
 *                                            (amount: text in major units,
 *                                            never type=number; currency: a
 *                                            <select> of codes; the close
 *                                            date: input[type="date"]; contact
 *                                            and account: search boxes)
 *     [data-picker-option="<record id>"]     a picker result, by name
 *     [data-field-clear="<field>"]           clears the contact or the account
 *     [data-conflict="<field>"]              D-L102's "changed by someone else"
 *     [data-field-error="<field>"]           a translated local refusal
 *     [data-action="save-deal"], [role="alert"]
 *   [data-action="move-deal"]                opens T-0109's move sheet and
 *                                            prompt, with T-0109's hooks:
 *   [data-testid="move-sheet"]               role=dialog, [data-move-to="<stage id>"]
 *   [data-testid="move-requirements"]        role=dialog, [data-requirement],
 *     [data-requirement-input], [data-picker-option], [data-conflict],
 *     [data-action="confirm-move"]
 *   [data-testid="timeline"]                 the deal timeline, containing
 *     [data-timeline-item="<item id>"]       one item, served order, with
 *       data-item-type="field_changed|activity"
 *       data-activity-id="<activity id>"     on activity items
 *       [data-actor]                         who acted ("System" for null)
 *       <time datetime="<ISO>">              every date or time drawn
 *   [data-testid="timeline-load-older"|"timeline-empty"|"timeline-error"]
 *   [data-action="log-activity"][data-activity-type="note|task|call"]
 *                                            (a bare [data-action="log-activity"]
 *                                            may reveal them) opens
 *   [data-testid="activity-form"]            [data-field-input="subject"|"body"|"dueAt"]
 *                                            (dueAt: input[type="datetime-local"],
 *                                            tasks only), [data-action="save-activity"],
 *                                            [role="alert"]
 *   [data-testid="activity-no-target"]       why nothing can be logged here
 *   [data-testid="record-skeleton"|"record-unavailable"|"record-not-found"]
 *   [data-requires-connection]               on every write control
 *   [data-testid="offline-banner"]           with the last-synced time
 *   [data-record-text]                       record data, not UI copy (en-XA)
 *
 * DESIGN AGAINST CONTRACT — WHERE THEY DISAGREE THE CONTRACT WINS (rulings)
 *
 *   Hidden: AI deal risk, products and price books, the FX lock and every
 *   US$ figure, VAT and totals, quotes, approvals and "Waiting for approval",
 *   contact roles, competitors, the forecast category ("Commit"), the deal
 *   type ("Renewal"), territory, lead source, the deal number, attachments,
 *   WhatsApp and email items, Undo. Money is EXACT, never compact (D-P19).
 *   The stage item on the timeline is by name only: no "Proposal →
 *   Negotiation" until a later contract edit (T-0111 R8).
 * ---------------------------------------------------------------------------
 */

const SCREEN = '[data-screen="P06/05"]';

/**
 * The /deals/[dealId] transferred-byte budget. PLACEHOLDER, TO BE PINNED BY
 * THE LEAD FROM MEASUREMENT (D-L118): the acceptance suite holds it at or
 * under 260,000 bytes and within 5% of what the run measures, so it fails
 * until the lead re-pins this one line to the builder's first green
 * measurement. Why the ceiling: see the budget test.
 */
const DEAL_BUDGET_BYTES = 252_000;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const EN = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>;

test.use({ timezoneId: 'Africa/Lagos' });

let active: DealMock | undefined;
let activeBoard: PipelineMock | undefined;

test.afterEach(async ({ page }) => {
  const mock = active;
  const board = activeBoard;
  active = undefined;
  activeBoard = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  for (const [what, faults, violations, requests] of [
    ['deal', mock?.mockFaults, mock?.violations, mock?.requests],
    ['pipeline', board?.mockFaults, board?.violations, board?.requests],
  ] as const) {
    if (faults === undefined || violations === undefined || requests === undefined) continue;
    expect(faults, `the ${what} MOCK answered something its contract rejects (a mock bug, not the screen’s)`).toEqual([]);
    expect(violations, `the screen sent the ${what} API something the contract or this screen’s rules do not allow`).toEqual([]);
    if (requests.length > 0) {
      const origin = new URL(pipelineUrl()).origin;
      for (const url of requests) expect(url.origin, 'the API must be called same-origin, by a relative path').toBe(origin);
    }
  }
});

function pipelineUrl(): string {
  const urls = stack() as unknown as Readonly<Record<string, unknown>>;
  const url = urls.webPipelineUrl;
  if (typeof url !== 'string' || url === '') {
    throw new Error(
      'the stack file has no webPipelineUrl: scripts/run-e2e.mjs starts no web process with crm_pipeline on ' +
        '(T-0109 wires it; see the header of p06-deal.spec.ts)',
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

function field(page: Page, name: string): Locator {
  return shown(screen(page).locator(`[data-field="${name}"]`)).first();
}

function related(page: Page, kind: 'contact' | 'account'): Locator {
  return shown(screen(page).locator(`[data-related="${kind}"]`)).first();
}

function lockIcon(scope: Locator): Locator {
  // `<Icon name="lock" />` is an aria-hidden ligature span whose text is its name.
  return scope.locator('[aria-hidden="true"]', { hasText: /^\s*lock\s*$/ });
}

/** The rendered text of `locator`, minus the subtrees `skip` matches. */
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

/** en.json labels under an id about deals or pipelines ending with one of `suffixes`. */
function dealLabels(...suffixes: string[]): string[] {
  return Object.entries(EN)
    .filter(([id]) => /deal|pipeline/i.test(id) && suffixes.some((suffix) => id.endsWith(suffix)))
    .map(([, text]) => text);
}

/** The former-checker label (D-L127): never the former-owner one. */
function formerCheckerLabels(): string[] {
  return Object.entries(EN)
    .filter(([id]) => /\.checker\.former$|\.formerChecker$|\.former_checker$|\.checkedBy\.former$|\.member\.former$|\.formerMember$/.test(id))
    .map(([, text]) => text);
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

/** The marks the BROWSER's own Intl gives a currency in the page's language. */
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

/** The element draws exactly this amount: its digits, and a mark of its currency. Never compact. */
async function expectMoney(page: Page, locator: Locator, amountMinor: string, currency: string, what: string): Promise<void> {
  const said = await visibleText(locator);
  expect(digits(said), `${what}: "${said}" is not exactly ${amountMinor} minor units of ${currency}`).toBe(moneyDigits(amountMinor));
  const marks = await currencyMarks(page, currency);
  expect(marks.some((mark) => said.includes(mark)), `${what}: "${said}" carries none of ${marks.join(', ')} for ${currency}`).toBe(true);
}

/** No UUID a person can see or hear: text, accessible-name attributes, form values and the title. */
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
  return locator.evaluate((element) => (element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true');
}

/** Every matching control is absent, disabled or aria-disabled. */
async function expectNoUsable(locator: Locator, what: string): Promise<void> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    expect(await isDisabled(locator.nth(index)), `${what} is offered and enabled (#${index})`).toBe(true);
  }
}

/** At least one matching control is visible and enabled. */
async function expectUsable(locator: Locator, what: string): Promise<void> {
  const candidates = shown(locator);
  await expect(candidates.first(), `${what} is not offered`).toBeVisible();
  const count = await candidates.count();
  let enabled = 0;
  for (let index = 0; index < count; index += 1) {
    if (!(await isDisabled(candidates.nth(index)))) enabled += 1;
  }
  expect(enabled, `${what} is offered but disabled`).toBeGreaterThan(0);
}

function json(body: unknown): Record<string, unknown> {
  expect(typeof body === 'object' && body !== null && !Array.isArray(body), 'the write body is not an object').toBe(true);
  return body as Record<string, unknown>;
}

function keysOf(body: Record<string, unknown>): string[] {
  return Object.keys(body).sort();
}

async function openDeal(page: Page, dealId: string, options: DealMockOptions & { query?: string } = {}): Promise<DealMock> {
  await page.clock.setFixedTime(new Date(NOW));
  const mock = await installDealMock(page, options);
  active = mock;
  const response = await page.goto(`${pipelineUrl()}/deals/${dealId}${options.query ?? ''}`);
  expect(response?.status(), '/deals/<id> with crm_pipeline on').toBe(200);
  if (options.networkFailure !== true) {
    await expect(screen(page)).toBeVisible();
    if (options.hold !== true) await expect(screen(page)).toHaveAttribute('data-record-state', 'ready');
  }
  return mock;
}

/** Another deal, under the mock already installed. */
async function gotoDeal(page: Page, dealId: string, query = ''): Promise<void> {
  const response = await page.goto(`${pipelineUrl()}/deals/${dealId}${query}`);
  expect(response?.status()).toBe(200);
  await expect(screen(page)).toHaveAttribute('data-record-state', 'ready');
}

/** Leave the current deal and its mock behind before opening another. */
async function closeDeal(page: Page): Promise<void> {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.mockFaults).toEqual([]);
    expect(mock.violations).toEqual([]);
  }
}

function heading(page: Page): Locator {
  return shown(screen(page).getByRole('heading', { level: 1 })).first();
}

function stageOf(row: StoredDeal) {
  const stage = [...PIPELINE_ONE.stages, ...PIPELINE_TWO.stages].find((candidate) => candidate.id === row.stageId);
  if (stage === undefined) throw new Error(`${row.name} sits in no stage`);
  return stage;
}

/** The targets the allow-list offers from a stage. */
function allowedFrom(stageId: string, pipeline = PIPELINE_ONE): string[] {
  return pipeline.transitions.filter((pair) => pair.fromStageId === stageId).map((pair) => pair.toStageId).sort();
}

async function openMoveSheet(page: Page): Promise<Locator> {
  const button = shown(screen(page).locator('[data-action="move-deal"]')).first();
  await expect(button, 'the deal has no move control').toBeVisible();
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

async function moveTo(page: Page, stageId: string): Promise<void> {
  const sheet = await openMoveSheet(page);
  await sheet.locator(`[data-move-to="${stageId}"]`).first().click();
}

async function prompt(page: Page): Promise<Locator> {
  const dialog = shown(page.getByTestId('move-requirements')).first();
  await expect(dialog, 'no requirement prompt opened').toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'dialog');
  return dialog;
}

function requirement(scope: Locator, id: string): Locator {
  return scope.locator(`[data-requirement="${id}"]`).first();
}

function requirementInput(dialog: Locator, id: string): Locator {
  return dialog.locator(`[data-requirement-input="${id}"]`).first();
}

function isMoveOf(request: { method(): string; url(): string }, dealId: string): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/deals/${dealId}/move`;
}

async function openEdit(page: Page): Promise<Locator> {
  await shown(screen(page).locator('[data-action="edit-deal"]')).first().click();
  const sheet = shown(page.getByTestId('deal-sheet')).first();
  await expect(sheet, 'the edit sheet did not open').toBeVisible();
  await expect(sheet).toHaveAttribute('role', 'dialog');
  return sheet;
}

function input(scope: Locator, name: string): Locator {
  return scope.locator(`[data-field-input="${name}"]`).first();
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

function item(page: Page, id: string): Locator {
  return shown(screen(page).locator(`[data-timeline-item="${id}"]`)).first();
}

async function renderedItemIds(page: Page): Promise<string[]> {
  return shown(screen(page).locator('[data-timeline-item]')).evaluateAll((items) => items.map((element) => element.getAttribute('data-timeline-item') ?? ''));
}

async function checkIds(page: Page): Promise<string[]> {
  return shown(screen(page).locator('[data-testid="deal-checks"] [data-check]')).evaluateAll((items) => items.map((element) => element.getAttribute('data-check') ?? ''));
}

/** True once the deal was re-read (getDeal) after its last write. */
function dealReReadAfterWrite(mock: DealMock, dealId: string): boolean {
  const write = mock.calls.findLastIndex((call) => call === `PATCH /api/v1/deals/${dealId}` || call === `POST /api/v1/deals/${dealId}/move`);
  return write >= 0 && mock.calls.slice(write + 1).includes(`GET /api/v1/deals/${dealId}`);
}

/** True once the timeline's first page was re-read after the last write. */
function timelineReReadAfterWrite(mock: DealMock, dealId: string): boolean {
  const write = mock.calls.findLastIndex((call) => /^(PATCH|POST) /.test(call));
  return write >= 0 && mock.calls.slice(write + 1).includes(`GET /api/v1/deals/${dealId}/timeline`);
}

const PSEUDO = /[·[\]äëïöüÄËÏÖÜ]/;

/** Everything of the deals and their timelines that could land on the device. Not ids: the address bar holds one because the user put it there. */
function needles(): string[] {
  const out = new Set<string>();
  for (const row of detailDeals()) {
    out.add(row.name);
    if (row.nextStep !== null) out.add(row.nextStep);
  }
  for (const entry of timelineOf(X_FULL.id)) {
    for (const value of [entry.subject, entry.body]) if (typeof value === 'string') out.add(value);
  }
  out.add(C_ALPHA.displayName);
  out.add(A_PHARMACY.name);
  return [...out];
}

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

test('the contract mock refuses what the contract and the screen’s rules refuse, and checks its own answers @p06-deal @p06-deal-mock', async ({ page }) => {
  // A validator only ever seen accepting proves nothing. Drive the mock with
  // fetch() from a page that exists today (sign-in on the default server) and
  // watch every malformed request land in `violations`, one at a time. No
  // `active` mock here: the violations are deliberate and counted explicitly.
  const { webUrl } = stack();
  const mock = await installDealMock(page);
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
    expect(added, `${method} ${path} was recorded more than once:\n${added.join('\n')}`).toHaveLength(1);
    planted += 1;
  };
  const deal = (id: string) => `/api/v1/deals/${id}`;
  const timeline = (id: string, query = '') => `/api/v1/deals/${id}/timeline${query === '' ? '' : `?${query}`}`;
  const activity = (extra: Record<string, unknown>) => ({ type: 'note', body: 'Synthetic note body', dealId: X_FULL.id, contactId: C_ALPHA.id, accountId: A_PHARMACY.id, ...extra });

  // Served as the contract says.
  const full = await call(deal(X_FULL.id));
  expect(full.status).toBe(200);
  expect(full.body.weightedAmount, 'half-even per deal: 1050000010.5 is 1050000010').toEqual({ amountMinor: '1050000010', currency: 'NGN' });
  const checks = full.body.checks as { requirementId: string; checkedBy: { id: string; displayName: string | null } }[];
  expect(checks.map((entry) => entry.requirementId)).toEqual([R_BUDGET.id, R_QUOTE.id, ORPHAN_REQUIREMENT_ID]);
  expect(checks.map((entry) => entry.checkedBy.displayName), 'a former checker is unnamed (D-L127)').toEqual([OTHER.displayName, null, ME.displayName]);
  expect(JSON.stringify(full.body)).not.toContain(FORMER_CHECKER.displayName);
  expect((await call(`/api/v1/pipelines/${PIPELINE_ONE.id}`)).body).toEqual(PIPELINE_ONE);
  const history = await call(timeline(X_FULL.id));
  expect((history.body.data as { id: string }[]).map((entry) => entry.id)).toEqual(timelineOf(X_FULL.id).map((entry) => entry.id));
  expect(history.body.nextCursor).toBeNull();
  expect((await call(deal(OUT_OF_SCOPE_DEAL_ID))).status, 'an unreachable deal is the API’s 404, not the screen’s fault').toBe(404);
  const picked = await call('/api/v1/contacts?q=buyer');
  expect((picked.body.data as { id: string }[]).map((entry) => entry.id).sort()).toEqual([C_ALPHA.id, C_ALPHA_ELSEWHERE.id, C_BETA.id].sort());
  const saved = await call(deal(X_FULL.id), 'PATCH', { version: 5, nextStep: 'Call the buyer on Friday' });
  expect([saved.status, saved.body.version, saved.body.nextStep]).toEqual([200, 6, 'Call the buyer on Friday']);
  const after = await call(timeline(X_FULL.id));
  expect((after.body.data as { field?: string }[])[0]?.field, 'the update left no timeline item').toBe('nextStep');
  const logged = await call('/api/v1/activities', 'POST', activity({}));
  expect([logged.status, logged.body.dealId, logged.body.id]).toEqual([201, X_FULL.id, NEW_ACTIVITY_IDS[0]]);
  expect(mock.violations, 'a well-formed request was recorded as a violation').toEqual([]);

  // Reads, refused and blamed on the screen.
  await expectViolation(deal('not-a-uuid'), 'GET', undefined, 404, /not a uuid/);
  await expectViolation(`${deal(X_FULL.id)}?include=all`, 'GET', undefined, 200, /takes no query/);
  await expectViolation(timeline(X_FULL.id, 'limit=101'), 'GET', undefined, 400, /outside 1\.\.100/);
  await expectViolation(timeline(X_FULL.id, 'cursor=forged'), 'GET', undefined, 400, /not served for this deal/);
  await expectViolation(timeline(X_FULL.id, 'sort=oldest'), 'GET', undefined, 400, /no "sort" parameter/);
  await expectViolation(`/api/v1/pipelines/${PIPELINE_ONE.id}/board`, 'GET', undefined, 404, /not an operation the deal detail uses/);
  await expectViolation(`/api/v1/activities/${String(NEW_ACTIVITY_IDS[0])}`, 'PATCH', { version: 1, completed: true }, 404, /not an operation/);
  await expectViolation(`/api/v1/pipelines/${PIPELINE_TWO.id}`, 'GET', undefined, 200, /before any deal of it was served/);
  await expectViolation(deal(X_FULL.id), 'GET', undefined, 200, /scope is never supplied/, { 'x-kasuwa-programme-id': PROGRAMME_ONE.id });

  // Updates, refused and blamed on the screen. X_FULL is at version 6 here.
  await expectViolation(deal(X_FULL.id), 'PATCH', { version: 6, nextStep: 'Call the buyer on Friday' }, 200, /already held at version 6/);
  // Version 7 now. A stale save is the API's 409, not the screen's fault; sending it again is.
  expect((await call(deal(X_FULL.id), 'PATCH', { version: 5, name: 'Synthetic rename' })).status).toBe(409);
  await expectViolation(deal(X_FULL.id), 'PATCH', { version: 5, name: 'Synthetic rename' }, 409, /blind retry/);
  // Not OTHER: X_FULL is OTHER's, so that would also be "already held". A member id the screen never offers.
  await expectViolation(deal(X_FULL.id), 'PATCH', { version: 7, ownerUserId: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e05' }, 400, /assign to me/);
  await expectViolation(deal(X_FULL.id), 'PATCH', { version: 7, ownerUserId: null }, 400, /assign to me/);
  await expectViolation(deal(X_FULL.id), 'PATCH', { version: 7, stageId: S_CONTRACT.id }, 400, /closed body/);
  await expectViolation(deal(X_FULL.id), 'PATCH', { version: 7, name: '   ' }, 400, /blank name/);
  await expectViolation(deal(X_FULL.id), 'PATCH', { version: 7, primaryContactId: C_ALPHA_ELSEWHERE.id }, 400, /another programme/);
  await expectViolation(deal(X_FULL.id), 'PATCH', { version: 7, accountId: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c99' }, 400, /never offered by the picker/);
  await expectViolation(deal(X_FULL.id), 'PATCH', { version: 7, amount: { amountMinor: '100', currency: 'USD' } }, 400, /not one of NGN/);
  expect((await call(deal(E_Q1.id))).status).toBe(200);
  await expectViolation(deal(E_Q1.id), 'PATCH', { version: E_Q1.version, amount: { amountMinor: '100', currency: 'NGN' } }, 403, /cannot read/);
  await expectViolation(deal(X_FULL.id), 'POST', undefined, 404, /not an operation/);

  // Moves: T-0109's rules. X_FULL (Negotiation) to Won skips Contract.
  await expectViolation(`${deal(X_FULL.id)}/move`, 'POST', { version: 7, toStageId: S_WON.id }, 409, /allow-list the screen read/);
  // R_DRIFT is no stage's requirement here (and not recorded on the deal, which would be a second finding).
  await expectViolation(`${deal(X_FULL.id)}/move`, 'POST', { version: 7, toStageId: S_CONTRACT.id, checks: [R_DRIFT.id] }, 400, /checks\.0 is not one of the target/);

  // Activities, refused and blamed on the screen.
  await expectViolation('/api/v1/activities', 'POST', activity({ contactId: C_BETA.id }), 400, /served primary contact/);
  await expectViolation('/api/v1/activities', 'POST', activity({ accountId: null }), 400, /served account/);
  await expectViolation('/api/v1/activities', 'POST', activity({ dealId: D_Q2.id }), 400, /not the deal on screen/);
  expect((await call(deal(D_Q1.id))).status).toBe(200);
  await expectViolation('/api/v1/activities', 'POST', { type: 'note', body: 'x', dealId: D_Q1.id }, 400, /composer must not be offered/);
  await expectViolation('/api/v1/activities', 'POST', activity({ dueAt: '2026-10-14T14:00:00.000Z' }), 400, /dueAt on a non-task/);
  await expectViolation('/api/v1/activities', 'POST', activity({ ownerUserId: OTHER.id }), 400, /only the caller/);
  await expectViolation('/api/v1/activities', 'POST', activity({ subject: '' }), 400, /empty subject|too short/);
  await expectViolation('/api/v1/activities', 'POST', activity({ programmeId: PROGRAMME_ONE.id }), 400, /closed body/);
  expect(mock.violations.length, 'the refusals above were not all recorded, or one was recorded twice').toBe(planted);

  // Every mock installed from here on answers in place of the one before (Playwright's newest route wins).

  // The API's own refusals are not the screen's fault.
  const agent = await installDealMock(page, { role: 'agent' });
  await call(deal(X_FULL.id));
  expect((await call(deal(X_FULL.id), 'PATCH', { version: 5, nextStep: 'Agent edit' })).status, 'an agent edited another’s deal').toBe(403);
  await call(deal(X_MINE.id));
  expect((await call(deal(X_MINE.id), 'PATCH', { version: 3, nextStep: 'Agent edit' })).status, 'an agent may edit its own deal').toBe(200);
  const qa = await installDealMock(page, { role: 'qa_analyst' });
  await call(deal(X_FULL.id));
  expect((await call('/api/v1/activities', 'POST', activity({}))).status).toBe(403);
  const readOnly = await installDealMock(page, { readOnly: ['amount'] });
  await call(deal(X_FULL.id));
  const notEditable = await call(deal(X_FULL.id), 'PATCH', { version: 5, amount: { amountMinor: '1650000000', currency: 'NGN' } });
  expect([notEditable.status, notEditable.body.details]).toEqual([403, [{ path: 'amount', code: 'field_not_editable' }]]);
  const hidden = await installDealMock(page, { activityDealLink: 'hidden' });
  await call(deal(X_FULL.id));
  expect(((await call(timeline(X_FULL.id))).body.data as { type: string }[]).some((entry) => entry.type === 'activity'), 'an activity item with its deal link withheld').toBe(false);
  const linkRefused = await call('/api/v1/activities', 'POST', activity({}));
  expect([linkRefused.status, linkRefused.body.details]).toEqual([403, [{ path: 'dealId', code: 'field_not_editable' }]]);
  const writeOnly = await installDealMock(page, { activityDealLink: 'writeOnly' });
  await call(deal(X_FULL.id));
  const unseen = await call('/api/v1/activities', 'POST', activity({}));
  expect([unseen.status, 'dealId' in unseen.body, unseen.body.withheldFields]).toEqual([201, false, ['dealId']]);
  expect(((await call(timeline(X_FULL.id))).body.data as { type: string }[]).some((entry) => entry.type === 'activity')).toBe(false);
  for (const other of [agent, qa, readOnly, hidden, writeOnly]) {
    expect(other.violations, 'an API refusal was blamed on the screen').toEqual([]);
  }

  // D-L102 on the wire: somebody else saves first; the blind retry, the undoing resend and the honest rebase are told apart.
  const stale = await installDealMock(page, { concurrent: { dealId: X_FULL.id, changes: [{ nextStep: 'Changed at another desk' }] } });
  await call(deal(X_FULL.id));
  const lost = await call(deal(X_FULL.id), 'PATCH', { version: 5, expectedCloseDate: '2026-11-14' });
  expect([lost.status, lost.body.code]).toEqual([409, 'stale_write']);
  expect(stale.violations, 'a save beaten by somebody else was blamed on the screen').toEqual([]);
  const fresh = await call(deal(X_FULL.id));
  expect(fresh.body).toMatchObject({ version: 6, nextStep: 'Changed at another desk' });
  await call(deal(X_FULL.id), 'PATCH', { version: 6, expectedCloseDate: '2026-11-14', nextStep: 'Send the revised quote' });
  expect(stale.violations.join('\n'), 'resending the replaced value was not recorded').toMatch(/just replaced/);
  const staleViolations = stale.violations.length;
  const rebased = await call(deal(X_FULL.id), 'PATCH', { version: 7, expectedCloseDate: '2026-11-15' });
  expect([rebased.status, rebased.body.version]).toEqual([200, 8]);
  expect(stale.violations).toHaveLength(staleViolations);

  // Reconfiguration after the screen's first read: the 422 names an id the screen learns by re-reading.
  const drift = await installDealMock(page, { requirementDrift: true });
  await call(deal(D_Q1.id));
  await call(`/api/v1/pipelines/${PIPELINE_ONE.id}`);
  const unmet = await call(`${deal(D_Q1.id)}/move`, 'POST', { version: D_Q1.version, toStageId: S_DISCOVERY.id });
  expect([unmet.status, unmet.body.details]).toEqual([422, [{ path: `requirements.${R_DRIFT.id}`, code: 'requirement_unmet' }]]);
  expect(drift.violations).toEqual([]);

  // The mock checks its own answers: a planted body the contract rejects is caught.
  expect(dealAnswerProblems('getDeal', 200, { ...full.body, probabilityBp: 7000 }).join('\n'), 'a probability on a deal passed').toMatch(/probabilityBp/);
  expect(dealAnswerProblems('getDeal', 200, { ...full.body, amount: { amountMinor: 15.5, currency: 'NGN' } })).not.toEqual([]);
  expect(dealAnswerProblems('getDeal', 200, { ...full.body, checks: [{ ...checks[0], checkedBy: { id: OTHER.id, displayName: OTHER.displayName, email: 'x@example.com' } }] }).join('\n')).toMatch(/email/);
  expect(dealAnswerProblems('getDeal', 200, full.body), 'a former checker’s null name is not contract-valid: the DealActor edit is missing').toEqual([]);
  const item0 = (history.body.data as Record<string, unknown>[])[1] ?? {};
  expect(item0.type, 'the fixture’s second item is no longer a field change').toBe('field_changed');
  expect(dealAnswerProblems('listDealTimeline', 200, { data: [item0], nextCursor: null })).toEqual([]);
  expect(dealAnswerProblems('listDealTimeline', 200, { data: [{ ...item0, before: 'x' }], nextCursor: null }), 'a value on a name-only item passed').not.toEqual([]);
  expect(dealAnswerProblems('listDealTimeline', 200, { data: [], nextCursor: null, total: 3 }).join('\n')).toMatch(/total/);
  expect(dealAnswerProblems('updateDeal', 422, { statusCode: 422 }).join('\n')).toMatch(/declares no 422/);
  expect(dealAnswerProblems('createActivity', 201, { ...logged.body, contact: { id: C_ALPHA.id } }).join('\n')).toMatch(/contact/);

  // The deliberate faults are served and filed apart.
  const hostile = await installDealMock(page, { hostileSummaries: true });
  await call(deal(D_Q_MARKUP.id));
  expect(hostile.plantedFaults.length, 'the hostile summaries were not served').toBeGreaterThan(0);
  for (const other of [mock, agent, qa, readOnly, hidden, writeOnly, stale, drift, hostile]) {
    expect(other.mockFaults).toEqual([]);
  }
});

// ===========================================================================
// The flag (R1)
// ===========================================================================

test.describe('crm_pipeline gates /deals/<id>', () => {
  // The flag-off tests PASS BEFORE THE WORK STARTS: there is no route, so the
  // path is a 404 everywhere. A negative invariant, legitimately vacuous until
  // the screen exists; the flag-on test gives the pair meaning.
  test('/deals/<id> is a real 404 with every flag at its default, and nothing reaches the API @p06-deal @p06-deal-flag-off', async ({ page }) => {
    const { webUrl } = stack();
    const mock = await installDealMock(page);
    for (const path of [`/deals/${X_FULL.id}`, '/deals/not-a-uuid']) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} is reachable with crm_pipeline off`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    expect(mock.requests.filter((url) => /^\/api\/v1\/(pipelines|deals|activities)/.test(url.pathname)), 'a flag-off page still read deals').toEqual([]);
  });

  test('/deals/<id> cannot be switched on by anything the browser sends @p06-deal @p06-deal-flag-off', async ({ browser }) => {
    const { webUrl } = stack();
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-kasuwa-feature-flags': 'crm_pipeline,crm_records', 'x-crm-pipeline': '1', 'x-kasuwa-tenant-id': TENANT_A },
    });
    await context.addCookies([
      { name: 'crm_pipeline', value: 'on', url: webUrl },
      { name: 'kasuwa_flags', value: 'crm_pipeline', url: webUrl },
    ]);
    const page = await context.newPage();
    for (const path of [`/deals/${X_FULL.id}?crm_pipeline=on&flags=crm_pipeline`, `/deals/${X_FULL.id}/`, `/deals/${X_FULL.id}?locale=en-XA`]) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} was switched on from the browser`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    await context.close();
  });

  test('/deals/<id> renders the deal with crm_pipeline on @p06-deal @p06-deal-flag-on', async ({ page }) => {
    await openDeal(page, X_FULL.id);
    await expect(heading(page)).toContainText(X_FULL.name);
  });
});

// ===========================================================================
// The shell, and the board's link to the deal (R2, R15 of T-0109)
// ===========================================================================

test('the deal sits in the CRM shell, Deals is current, the breadcrumb links its pipeline, the title keeps no name, and no link is a 404 @p06-deal @p06-deal-shell', async ({ page }) => {
  await openDeal(page, X_FULL.id);
  const shell = page.locator('[data-shell="crm"]');
  await expect(shell).toBeVisible();
  await expect(shell.locator(SCREEN)).toBeVisible();
  await expect(shown(shell.locator('nav a[href="/pipelines"]')).first(), 'the Deals entry is not current on the deal').toHaveAttribute('aria-current', 'page');
  const crumb = shown(page.getByTestId('deal-breadcrumb')).first();
  await expect(crumb.locator(`a[href="/pipelines/${PIPELINE_ONE.id}"]`), 'the breadcrumb does not link the deal’s pipeline').toHaveCount(1);
  expect(await visibleText(crumb)).toContain(PIPELINE_ONE.name);
  // D-L91: a deal name is personal data; titles land in browser history on shared BPO desks (D-L63).
  expect(await page.title(), 'the document title carries the deal’s name').not.toContain(X_FULL.name);

  const hrefs = [...new Set(await page.locator('a[href^="/"]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? '')))];
  expect(hrefs.length, 'the page links nowhere — not even the CRM nav').toBeGreaterThan(0);
  for (const href of hrefs) {
    const response = await page.request.get(`${pipelineUrl()}${href}`);
    expect(response.status(), `the page links to ${href}, which is a 404`).not.toBe(404);
  }
});

test('every board card’s name links its deal, and the link opens the detail (T-0109 R15) @p06-deal @p06-deal-board-link', async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  activeBoard = await installPipelineMock(page);
  active = await installDealMock(page, { behindBoard: true });
  const response = await page.goto(`${pipelineUrl()}/pipelines/${PIPELINE_ONE.id}`);
  expect(response?.status()).toBe(200);
  const target = shown(page.locator(`[data-deal-card="${D_N2.id}"]`)).first();
  await expect(target).toBeVisible();
  const cards = await shown(page.locator('[data-deal-card]')).evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.getAttribute('data-deal-card') ?? '',
      links: Array.from(element.querySelectorAll('[data-field="name"] a[href]')).map((anchor) => anchor.getAttribute('href') ?? ''),
    })),
  );
  expect(cards.length, 'the board drew no cards').toBeGreaterThan(5);
  for (const entry of cards) {
    expect(entry.links, `the card ${entry.id} does not link its deal from its name exactly once`).toEqual([`/deals/${entry.id}`]);
  }
  await target.locator(`[data-field="name"] a[href="/deals/${D_N2.id}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/deals/${D_N2.id}$`));
  await expect(screen(page)).toHaveAttribute('data-record-state', 'ready');
  await expect(heading(page)).toContainText(D_N2.name);
});

// ===========================================================================
// P06/05 — the header and fields
// ===========================================================================

test.describe('P06/05 — the header and fields', () => {
  test('name, stage and its path, the current stage’s requirements, money, close date, owner, contact, account and next step; axe-clean @p06-deal @p06-deal-header', async ({ page }) => {
    const mock = await openDeal(page, X_FULL.id);
    await expect(heading(page)).toContainText(X_FULL.name);
    expect(await visibleText(field(page, 'stage'))).toContain(S_NEGOTIATION.name);

    const path = shown(screen(page).getByTestId('stage-path')).first();
    await expect(path).toHaveAttribute('role', 'list');
    const steps = await shown(path.locator('[data-stage-step]')).evaluateAll((elements) =>
      elements.map((element) => [element.getAttribute('data-stage-step') ?? '', element.getAttribute('aria-current') ?? ''] as const),
    );
    expect(steps.map(([id]) => id), 'the path is not every open stage then won, in order, without lost').toEqual(boardStages(PIPELINE_ONE).map((stage) => stage.id));
    expect(steps.filter(([, current]) => current === 'step').map(([id]) => id), 'the current stage is not marked on the path').toEqual([S_NEGOTIATION.id]);
    for (const stage of boardStages(PIPELINE_ONE)) {
      expect(await visibleText(path.locator(`[data-stage-step="${stage.id}"]`).first())).toContain(stage.name);
    }

    const requirements = shown(screen(page).getByTestId('stage-requirements')).first();
    const listed = await shown(requirements.locator('[data-requirement]')).evaluateAll((elements) => elements.map((element) => element.getAttribute('data-requirement') ?? ''));
    expect(listed, 'the current stage’s requirements are not all listed').toEqual(S_NEGOTIATION.requirements.map((entry) => entry.id));
    for (const id of [R_AMOUNT.id, R_CLOSE.id, R_QUOTE.id]) {
      await expect(requirement(requirements, id), 'a met requirement is drawn unmet').toHaveAttribute('data-met', 'true');
    }
    expect(await visibleText(requirement(requirements, R_QUOTE.id)), 'a check is not labelled word for word').toContain(String(R_QUOTE.label));
    await expectSaysOneOf(requirement(requirements, R_AMOUNT.id), dealLabels('.field.amount'), 'the amount requirement');
    await expectSaysOneOf(requirement(requirements, R_CLOSE.id), dealLabels('.field.expectedCloseDate'), 'the close-date requirement');

    await expectMoney(page, field(page, 'amount'), '1500000015', 'NGN', 'the amount');
    await expectMoney(page, field(page, 'weightedAmount'), '1050000010', 'NGN', 'the weighted amount (half-even, as served)');
    await expect(field(page, 'expectedCloseDate').locator('time[datetime="2026-10-31"]')).toHaveCount(1);
    expect(await visibleText(field(page, 'owner'))).toContain(OTHER.displayName);
    await expect(related(page, 'contact').locator(`a[href="/contacts/${C_ALPHA.id}"]`)).toHaveCount(1);
    expect(await visibleText(related(page, 'contact'))).toContain(C_ALPHA.displayName);
    await expect(related(page, 'account').locator(`a[href="/accounts/${A_PHARMACY.id}"]`)).toHaveCount(1);
    expect(await visibleText(related(page, 'account'))).toContain(A_PHARMACY.name);
    expect(await visibleText(field(page, 'nextStep'))).toContain(String(X_FULL.nextStep));

    expect(mock.pipelineReads.map((url) => url.pathname), 'the stage path is not drawn from the deal’s pipeline').toContain(`/api/v1/pipelines/${PIPELINE_ONE.id}`);
    expect(mock.timelineReads.length, 'the timeline was never read').toBeGreaterThan(0);
    await expectNoIdsAnywhere(page, 'the deal header');
    await expectNoSeriousAxe(page, 'P06/05');

    // A requirement of the current stage can be unmet (configured after the deal entered): said, not hidden.
    await gotoDeal(page, X_MINE.id);
    await expect(requirement(shown(screen(page).getByTestId('stage-requirements')).first(), R_BUDGET.id)).toHaveAttribute('data-met', 'false');
  });

  test('every amount is exact, in its currency’s own Intl format, as served, never compact or recomputed @p06-deal @p06-deal-money', async ({ page }) => {
    await openDeal(page, D_BIG.id);
    // D_P3: 1000000001 at 50% is 500000000.5, half-even to 500000000. A float would round it to 500000001.
    for (const row of [D_BIG, D_P2, D_C1, D_N2, D_P3]) {
      if (row !== D_BIG) await gotoDeal(page, row.id);
      const money = row.amount;
      if (money === null) throw new Error(`${row.name} has no amount`);
      await expectMoney(page, field(page, 'amount'), money.amountMinor, money.currency, `${row.name}’s amount`);
      await expectMoney(page, field(page, 'weightedAmount'), weightedMinor(money.amountMinor, stageOf(row).probabilityBp), money.currency, `${row.name}’s weighted amount`);
    }
    expect(digits(await visibleText(field(page, 'weightedAmount')))).not.toBe('500000001');
  });

  test.describe('in a zone west of UTC', () => {
    // Cabo Verde is UTC-1. A calendar date read as UTC midnight and drawn in the
    // browser's zone becomes the day before; Lagos (UTC+1) would hide that.
    test.use({ timezoneId: 'Atlantic/Cape_Verde' });
    test('the expected close date is the calendar date as served, never shifted by the browser’s zone @p06-deal @p06-deal-dates', async ({ page }) => {
      await openDeal(page, X_FULL.id);
      const close = field(page, 'expectedCloseDate');
      await expect(close.locator('time[datetime="2026-10-31"]')).toHaveCount(1);
      // Shifted, it would read the 30th: no 31 anywhere in "30 Oct 2026", "30/10/2026" or "Oct 30, 2026".
      const said = digits(await visibleText(close));
      expect(said, `the close date "${said}" is not the 31st: it moved with the browser’s zone`).toContain('31');
    });
  });

  test('summaries link only from well-formed uuids; a name with markup is text; no id is printed @p06-deal @p06-deal-links', async ({ page }) => {
    const mock = await openDeal(page, D_Q_MARKUP.id, { hostileSummaries: true });
    expect(mock.plantedFaults.length, 'the hostile summaries were not served').toBeGreaterThan(0);
    await expect(heading(page)).toContainText(HOSTILE_NAME);
    expect(await page.evaluate(() => (window as unknown as { __kasuwaXss?: number }).__kasuwaXss), 'markup in a deal name ran').toBeUndefined();
    await expect(screen(page).locator('[data-related] a'), 'a summary with a malformed id is a link').toHaveCount(0);
    expect(await visibleText(related(page, 'contact'))).toContain('Synthetic Hostile Contact');
    expect(await visibleText(related(page, 'account'))).toContain('Synthetic Hostile Account');
    const hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
    expect(hrefs.filter((href) => /javascript:|\.\.\//i.test(href)), 'a hostile id reached an href').toEqual([]);
    await expectNoIdsAnywhere(page, 'the deal with hostile summaries');
  });
});

// ===========================================================================
// Withheld fields, owners and checks (D-P23, D-L127)
// ===========================================================================

test.describe('withheld fields, owners and checks', () => {
  test('withheld fields are locks, never zero; name is never withheld; null is not a lock; a former owner is named neutrally @p06-deal @p06-deal-locked', async ({ page }) => {
    await openDeal(page, E_Q1.id);
    for (const name of ['amount', 'weightedAmount', 'owner', 'expectedCloseDate']) {
      const cell = field(page, name);
      await expect(cell, `the withheld ${name} is not a lock`).toHaveAttribute('data-locked', 'true');
      await expect(lockIcon(cell)).toHaveCount(1);
      const said = await visibleText(cell);
      expect(said, `the withheld ${name} is blank`).not.toBe('');
      expect(said, `the withheld ${name} draws a number`).not.toMatch(/\d/);
    }
    await expect(heading(page)).toContainText(E_Q1.name);
    await expect(lockIcon(heading(page)), 'the name is drawn as withheld').toHaveCount(0);
    const copy = await visibleText(screen(page));
    for (const currency of CURRENCIES) {
      for (const mark of (await currencyMarks(page, currency)).filter((entry) => !/^[A-Za-z]$/.test(entry))) {
        expect(copy.includes(mark), `money (${mark}) is drawn with the amount withheld`).toBe(false);
      }
    }
    await expectNoUsable(screen(page).locator('[data-action="assign-to-me"]'), 'assign to me with the owner withheld');
    await closeDeal(page);

    // Everything withholdable withheld: the name still stands; every other field is a lock; nothing to log against.
    await openDeal(page, X_FULL.id, { withheld: WITHHOLDABLE_FIELDS });
    await expect(heading(page)).toContainText(X_FULL.name);
    await expect(lockIcon(heading(page))).toHaveCount(0);
    for (const cell of [field(page, 'amount'), field(page, 'weightedAmount'), field(page, 'expectedCloseDate'), field(page, 'owner'), field(page, 'nextStep'), related(page, 'contact'), related(page, 'account')]) {
      await expect(cell).toHaveAttribute('data-locked', 'true');
      await expect(lockIcon(cell)).toHaveCount(1);
    }
    const requirements = shown(screen(page).getByTestId('stage-requirements')).first();
    for (const id of [R_AMOUNT.id, R_CLOSE.id]) {
      await expect(requirement(requirements, id), 'a requirement on a withheld field is not a lock').toHaveAttribute('data-locked', 'true');
    }
    await expect(requirement(requirements, R_QUOTE.id)).toHaveAttribute('data-met', 'true');
    const sheet = await openEdit(page);
    const offered = await shown(sheet.locator('[data-field-input]')).evaluateAll((inputs) => inputs.map((element) => element.getAttribute('data-field-input') ?? ''));
    expect([...new Set(offered)], 'the edit sheet offers a withheld field').toEqual(['name']);
    await page.keyboard.press('Escape');
    await expectNoUsable(screen(page).locator('[data-action="log-activity"]'), 'logging an activity with no visible contact or account');
    await expect(shown(screen(page).getByTestId('activity-no-target')).first()).toBeVisible();
    await expectNoIdsAnywhere(page, 'everything withheld');
    await closeDeal(page);

    // A former owner is not an id; no amount is not a lock; unassigned is not a lock.
    await openDeal(page, D_D2.id);
    await expectSaysOneOf(field(page, 'owner'), [EN['records.owner.former'] ?? ''].filter((text) => text !== ''), 'a former owner');
    expect(await field(page, 'amount').getAttribute('data-locked'), 'a deal with no amount is drawn as withheld').not.toBe('true');
    expect(digits(await visibleText(field(page, 'amount'))), 'no amount is drawn as zero').toBe('');
    expect(digits(await visibleText(field(page, 'weightedAmount'))), 'no weighted amount is drawn as zero').toBe('');
    await expectNoIdsAnywhere(page, 'a former owner');
    await gotoDeal(page, D_Q2.id);
    expect(await field(page, 'owner').getAttribute('data-locked'), 'an unassigned deal is drawn as withheld').not.toBe('true');
    expect(await visibleText(field(page, 'owner'))).not.toContain(EN['records.owner.former'] ?? '<none>');
    expect(await visibleText(field(page, 'owner'))).not.toBe('');
  });

  test('each check shows who ticked it and when; a former checker is unnamed; a check no longer configured prints no id @p06-deal @p06-deal-checks', async ({ page }) => {
    await openDeal(page, X_FULL.id);
    expect(await checkIds(page), 'the checks are not the served ones, in served order').toEqual(X_FULL.checks.map((entry) => entry.requirementId));
    const checks = shown(screen(page).getByTestId('deal-checks')).first();
    for (const entry of X_FULL.checks) {
      const row = checks.locator(`[data-check="${entry.requirementId}"]`).first();
      const instants = await row.locator('time[datetime]').evaluateAll((times) => times.map((time) => Date.parse(time.getAttribute('datetime') ?? '')));
      expect(instants, `the check ${entry.requirementId} does not say when`).toContain(Date.parse(entry.checkedAt));
      await expect(row.locator('[data-checked-by]').first()).toBeVisible();
    }
    const budget = checks.locator(`[data-check="${R_BUDGET.id}"]`).first();
    expect(await visibleText(budget)).toContain(String(R_BUDGET.label));
    expect(await visibleText(budget.locator('[data-checked-by]').first())).toContain(OTHER.displayName);

    const quote = checks.locator(`[data-check="${R_QUOTE.id}"]`).first();
    expect(await visibleText(quote)).toContain(String(R_QUOTE.label));
    const by = quote.locator('[data-checked-by]').first();
    await expectSaysOneOf(by, formerCheckerLabels(), 'a former checker (D-L127)');
    expect(await visibleText(by), 'a former checker is drawn as an owner').not.toContain(EN['records.owner.former'] ?? '<none>');
    expect(await visibleText(by)).not.toMatch(/\bnull\b|\bundefined\b/);
    // The mock never sends the former checker's name (D-L127); this guards against one invented from elsewhere.
    expect(await visibleText(screen(page))).not.toContain(FORMER_CHECKER.displayName);

    const orphan = checks.locator(`[data-check="${ORPHAN_REQUIREMENT_ID}"]`).first();
    expect(await visibleText(orphan.locator('[data-checked-by]').first())).toContain(ME.displayName);
    expect(await visibleText(orphan)).not.toMatch(/\bnull\b|\bundefined\b/);
    await expectNoIdsAnywhere(page, 'the checks');
  });
});

// ===========================================================================
// Edit (D-L102)
// ===========================================================================

test.describe('edit', () => {
  test('the edit sends version and only what changed, clears with null, picks only the deal’s programme, and draws the answer @p06-deal @p06-deal-edit', async ({ page }) => {
    const mock = await openDeal(page, X_FULL.id);
    let sheet = await openEdit(page);
    await expect(input(sheet, 'name'), 'the sheet is not opened on the deal').toHaveValue(X_FULL.name);
    expect(await input(sheet, 'amount').getAttribute('type'), 'the amount is a number input').not.toBe('number');
    const codes = await input(sheet, 'currency').locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).filter((value) => value !== ''));
    expect([...codes].sort(), 'the currencies offered are not exactly NGN, GHS, KES and ZAR').toEqual([...CURRENCIES].sort());
    await expect(input(sheet, 'expectedCloseDate')).toHaveAttribute('type', 'date');
    await expect(sheet.locator('[data-field-input="ownerUserId"], [data-field-input="owner"]'), 'the sheet offers an owner picker (R11)').toHaveCount(0);
    await expect(sheet.locator('[data-action="save-deal"]').first()).toHaveAttribute('data-requires-connection', /.*/);
    await expectNoSeriousAxe(page, 'the edit sheet');

    await input(sheet, 'name').fill('Synthetic Foods Q4 supply renewed');
    await input(sheet, 'nextStep').fill('Call the buyer on Friday');
    await input(sheet, 'expectedCloseDate').fill('2026-11-14');
    let sent = page.waitForRequest((request) => isUpdateDeal(request, X_FULL.id));
    await sheet.locator('[data-action="save-deal"]').first().click();
    expect(json((await sent).postDataJSON()), 'the first save is not version plus what changed').toEqual({
      version: 5,
      name: 'Synthetic Foods Q4 supply renewed',
      nextStep: 'Call the buyer on Friday',
      expectedCloseDate: '2026-11-14',
    });
    await expect(heading(page)).toContainText('Synthetic Foods Q4 supply renewed');
    await expect(shown(page.getByTestId('deal-sheet'))).toHaveCount(0);
    expect(await visibleText(field(page, 'nextStep'))).toContain('Call the buyer on Friday');
    await expect(field(page, 'expectedCloseDate').locator('time[datetime="2026-11-14"]')).toHaveCount(1);
    await expect.poll(() => timelineReReadAfterWrite(mock, X_FULL.id), { message: 'the timeline was not re-read after the save' }).toBe(true);

    // The amount, and clearing the account (null, never an empty string).
    sheet = await openEdit(page);
    await input(sheet, 'amount').fill('16500000');
    await sheet.locator('[data-field-clear="accountId"]').first().click();
    sent = page.waitForRequest((request) => isUpdateDeal(request, X_FULL.id));
    await sheet.locator('[data-action="save-deal"]').first().click();
    expect(json((await sent).postDataJSON())).toEqual({ version: 6, amount: { amountMinor: '1650000000', currency: 'NGN' }, accountId: null });
    await expectMoney(page, field(page, 'amount'), '1650000000', 'NGN', 'the saved amount');
    await expectMoney(page, field(page, 'weightedAmount'), '1155000000', 'NGN', 'the weighted amount the server answered');
    await expect(related(page, 'account').locator('a')).toHaveCount(0);
    expect(await visibleText(related(page, 'account')), 'a cleared account is blank').not.toBe('');

    // A blank name is refused before anything is sent; retyping the saved name is no change; the contact from the deal's programme.
    sheet = await openEdit(page);
    await input(sheet, 'name').fill('   ');
    await sheet.locator('[data-action="save-deal"]').first().click();
    await expect(shown(sheet.locator('[data-field-error="name"]')).first(), 'a blank name is not refused locally').toBeVisible();
    expect(mock.writes, 'a blank name was sent').toHaveLength(2);
    await input(sheet, 'name').fill('Synthetic Foods Q4 supply renewed');
    await input(sheet, 'nextStep').fill('');
    await input(sheet, 'primaryContactId').fill('Buyer');
    const option = shown(page.locator(`[data-picker-option="${C_BETA.id}"]`)).first();
    await expect(option, 'the picker did not offer the contact').toBeVisible();
    await expect(shown(page.locator(`[data-picker-option="${C_ALPHA_ELSEWHERE.id}"]`)), 'the picker offered another programme’s contact').toHaveCount(0);
    await option.click();
    sent = page.waitForRequest((request) => isUpdateDeal(request, X_FULL.id));
    await sheet.locator('[data-action="save-deal"]').first().click();
    expect(json((await sent).postDataJSON()), 'the third save sent more than what changed').toEqual({ version: 7, nextStep: null, primaryContactId: C_BETA.id });
    await expect(related(page, 'contact').locator(`a[href="/contacts/${C_BETA.id}"]`)).toHaveCount(1);
    expect(mock.writes.map((write) => write.status)).toEqual([200, 200, 200]);
    await expectNoIdsAnywhere(page, 'after the edits');
  });

  test('a 409 stale_write re-reads and rebases: the typed values stay, a field both changed is noted, and the second save is on the fresh version @p06-deal @p06-deal-edit-stale', async ({ page }) => {
    const mock = await openDeal(page, X_FULL.id, { concurrent: { dealId: X_FULL.id, changes: [{ nextStep: 'Changed at another desk' }] } });
    let sheet = await openEdit(page);
    await input(sheet, 'expectedCloseDate').fill('2026-11-14');
    await input(sheet, 'nextStep').fill('Typed at this desk');
    const lost = page.waitForResponse((response) => isUpdateDeal(response.request(), X_FULL.id));
    await sheet.locator('[data-action="save-deal"]').first().click();
    expect((await lost).status()).toBe(409);
    await expect.poll(() => dealReReadAfterWrite(mock, X_FULL.id), { message: 'the deal was not re-read after the 409' }).toBe(true);
    sheet = shown(page.getByTestId('deal-sheet')).first();
    await expect(sheet, 'the sheet closed on a 409').toBeVisible();
    await expect(input(sheet, 'expectedCloseDate'), 'the typed close date was lost').toHaveValue('2026-11-14');
    await expect(input(sheet, 'nextStep'), 'the typed next step was lost').toHaveValue('Typed at this desk');
    await expect(shown(sheet.locator('[data-conflict="nextStep"]')).first(), 'no "changed by someone else" note on the field both changed').toBeVisible();
    await expect(shown(sheet.locator('[data-conflict="expectedCloseDate"]')), 'a conflict noted where nobody else changed the field').toHaveCount(0);
    expect(mock.writes, 'the 409 was retried by itself').toHaveLength(1);
    const second = page.waitForRequest((request) => isUpdateDeal(request, X_FULL.id));
    await sheet.locator('[data-action="save-deal"]').first().click();
    expect(json((await second).postDataJSON()), 'the second save is not the person’s edits on the fresh version').toEqual({ version: 6, expectedCloseDate: '2026-11-14', nextStep: 'Typed at this desk' });
    await expect(shown(page.getByTestId('deal-sheet'))).toHaveCount(0);
    expect(await visibleText(field(page, 'nextStep'))).toContain('Typed at this desk');
    expect(mock.writes.map((write) => write.status)).toEqual([409, 200]);
  });

  test('two 409s in a row: each re-read, the fresh values in the untouched fields, each resend on the fresh version, an untouched field never sent @p06-deal @p06-deal-edit-stale', async ({ page }) => {
    const mock = await openDeal(page, X_FULL.id, {
      concurrent: { dealId: X_FULL.id, changes: [{ name: 'Renamed at another desk' }, { name: 'Renamed again elsewhere' }] },
    });
    let sheet = await openEdit(page);
    await input(sheet, 'nextStep').fill('Only this changed');
    for (const version of [5, 6, 7]) {
      const sent = page.waitForRequest((request) => isUpdateDeal(request, X_FULL.id));
      await sheet.locator('[data-action="save-deal"]').first().click();
      expect(json((await sent).postDataJSON()), `save on version ${version}`).toEqual({ version, nextStep: 'Only this changed' });
      if (version < 7) {
        await expect.poll(() => mock.writes.at(-1)?.status).toBe(409);
        await expect.poll(() => dealReReadAfterWrite(mock, X_FULL.id)).toBe(true);
        sheet = shown(page.getByTestId('deal-sheet')).first();
        await expect(input(sheet, 'nextStep')).toHaveValue('Only this changed');
        await expect(input(sheet, 'name'), 'the untouched name is not the fresh one (D-L102)').toHaveValue(version === 5 ? 'Renamed at another desk' : 'Renamed again elsewhere');
        await expect(shown(sheet.locator('[data-conflict]')), 'a conflict noted where the person changed nothing').toHaveCount(0);
      }
    }
    await expect(shown(page.getByTestId('deal-sheet'))).toHaveCount(0);
    await expect(heading(page)).toContainText('Renamed again elsewhere');
    expect(mock.writes.map((write) => write.status)).toEqual([409, 409, 200]);
  });

  test('403 field_not_editable names the fields; 403 not_permitted is translated; the sheet and the typing stay; never retried; a withheld field is never offered @p06-deal @p06-deal-edit-refused', async ({ page }) => {
    let mock = await openDeal(page, X_FULL.id, { readOnly: ['amount'] });
    let sheet = await openEdit(page);
    await input(sheet, 'amount').fill('16500000');
    await input(sheet, 'nextStep').fill('Kept after a refusal');
    let answered = page.waitForResponse((response) => isUpdateDeal(response.request(), X_FULL.id));
    await sheet.locator('[data-action="save-deal"]').first().click();
    expect((await answered).status()).toBe(403);
    let alert = shown(sheet.getByRole('alert')).first();
    await expect(alert).toBeVisible();
    await expectSaysOneOf(alert, dealLabels('.field.amount'), 'the refusal naming the amount');
    await expect(sheet).toBeVisible();
    await expect(input(sheet, 'nextStep')).toHaveValue('Kept after a refusal');
    expect(mock.writes, 'the 403 was retried').toHaveLength(1);
    await page.keyboard.press('Escape');
    await expectMoney(page, field(page, 'amount'), '1500000015', 'NGN', 'the amount after a refused save');
    await expectNoIdsAnywhere(page, 'the field_not_editable refusal');
    await closeDeal(page);

    // A reader may not edit at all: the API's 403, in translated copy (en-XA proves it).
    mock = await openDeal(page, X_FULL.id, { role: 'qa_analyst', query: '?locale=en-XA' });
    sheet = await openEdit(page);
    await input(sheet, 'nextStep').fill('A reader tries');
    answered = page.waitForResponse((response) => isUpdateDeal(response.request(), X_FULL.id));
    await sheet.locator('[data-action="save-deal"]').first().click();
    expect((await answered).status()).toBe(403);
    alert = shown(sheet.getByRole('alert')).first();
    expect(await visibleText(alert), 'the refusal is the server message, not translated copy').toMatch(PSEUDO);
    await expect(input(sheet, 'nextStep')).toHaveValue('A reader tries');
    expect(mock.writes).toHaveLength(1);
    await closeDeal(page);

    // An agent and somebody else's deal.
    mock = await openDeal(page, X_FULL.id, { role: 'agent' });
    sheet = await openEdit(page);
    await input(sheet, 'nextStep').fill('An agent tries');
    answered = page.waitForResponse((response) => isUpdateDeal(response.request(), X_FULL.id));
    await sheet.locator('[data-action="save-deal"]').first().click();
    expect((await answered).status()).toBe(403);
    await expect(shown(sheet.getByRole('alert')).first()).toBeVisible();
    expect(mock.writes).toHaveLength(1);
    await page.keyboard.press('Escape');
    expect(await visibleText(field(page, 'nextStep')), 'a refused save was drawn').toContain(String(X_FULL.nextStep));
    await closeDeal(page);

    // PROGRAMME_TWO: the sheet offers no withheld field.
    await openDeal(page, E_Q1.id);
    sheet = await openEdit(page);
    await expect(shown(sheet.locator('[data-field-input="amount"], [data-field-input="currency"], [data-field-input="expectedCloseDate"]')), 'a withheld field is offered').toHaveCount(0);
    await expect(input(sheet, 'name')).toBeVisible();
  });

  test('assign to me is offered where it applies and sends only the caller; no other owner, no unassign; an agent’s 403 is a message @p06-deal @p06-deal-reassign', async ({ page }) => {
    const mock = await openDeal(page, X_FULL.id);
    const assign = () => screen(page).locator('[data-action="assign-to-me"]');
    await expectUsable(assign(), 'assign to me on a colleague’s deal');
    await expect(assign().first()).toHaveAttribute('data-requires-connection', /.*/);
    await expect(screen(page).locator('[data-action="unassign"], [data-action="reassign"]'), 'a reassignment the API refuses some callers is offered (R11)').toHaveCount(0);
    const sent = page.waitForRequest((request) => isUpdateDeal(request, X_FULL.id));
    await shown(assign()).first().click();
    expect(json((await sent).postDataJSON()), 'assign to me sent more than version and the caller').toEqual({ version: 5, ownerUserId: ME.id });
    await expect.poll(async () => visibleText(field(page, 'owner'))).toContain(ME.displayName);
    await expectNoUsable(assign(), 'assign to me on the caller’s own deal');
    expect(mock.writes).toHaveLength(1);

    for (const [row, offered] of [
      [X_MINE, false],
      [D_Q2, true],
      [D_D2, true],
      [E_Q1, false],
    ] as const) {
      await gotoDeal(page, row.id);
      if (offered) await expectUsable(assign(), `assign to me on ${row.name}`);
      else await expectNoUsable(assign(), `assign to me on ${row.name}`);
    }
    await closeDeal(page);

    // D-L84: nothing says whether the caller may; the API's 403 is the gate, drawn as a message, never retried.
    const agent = await openDeal(page, X_FULL.id, { role: 'agent' });
    const refused = page.waitForResponse((response) => isUpdateDeal(response.request(), X_FULL.id));
    await shown(assign()).first().click();
    expect((await refused).status()).toBe(403);
    await expect(shown(page.getByRole('alert')).first()).toBeVisible();
    expect(await visibleText(field(page, 'owner')), 'a refused assignment was drawn').toContain(OTHER.displayName);
    expect(agent.writes).toHaveLength(1);
  });
});

// ===========================================================================
// Moves (T-0109's sheet and prompt, from the detail)
// ===========================================================================

test.describe('moves', () => {
  test('the move sheet offers exactly the allow-list from the deal’s stage, lost included, by pointer and keyboard; the detail and its timeline follow @p06-deal @p06-deal-move', async ({ page }) => {
    const mock = await openDeal(page, D_Q1.id);
    const button = shown(screen(page).locator('[data-action="move-deal"]')).first();
    expect(await button.evaluate((element) => element.tagName === 'BUTTON' || element.getAttribute('role') === 'button'), 'the move control is not a button').toBe(true);
    await expect(button).toHaveAttribute('data-requires-connection', /.*/);
    const sheet = await openMoveSheet(page);
    const options = await moveOptions(sheet);
    expect(options.enabled, 'the sheet does not offer exactly the allow-list from Qualified').toEqual(allowedFrom(S_QUALIFIED.id));
    expect(options.enabled).toContain(S_LOST.id);
    expect(options.enabled, 'the sheet offers the stage the deal is in').not.toContain(S_QUALIFIED.id);
    expect(await visibleText(sheet.locator(`[data-move-to="${S_DISCOVERY.id}"]`).first())).toContain(S_DISCOVERY.name);
    const sent = page.waitForRequest((request) => isMoveOf(request, D_Q1.id));
    await sheet.locator(`[data-move-to="${S_DISCOVERY.id}"]`).first().click();
    expect(json((await sent).postDataJSON())).toEqual({ version: D_Q1.version, toStageId: S_DISCOVERY.id });
    await expect.poll(async () => visibleText(field(page, 'stage'))).toContain(S_DISCOVERY.name);
    await expect(shown(screen(page).locator(`[data-testid="stage-path"] [data-stage-step="${S_DISCOVERY.id}"]`)).first()).toHaveAttribute('aria-current', 'step');
    await expect.poll(() => timelineReReadAfterWrite(mock, D_Q1.id), { message: 'the timeline was not re-read after the move' }).toBe(true);
    const newest = shown(screen(page).locator('[data-timeline-item]')).first();
    await expect(newest).toHaveAttribute('data-item-type', 'field_changed');
    await expectSaysOneOf(newest, dealLabels('.field.stageId'), 'the move on the timeline');

    // The keyboard alone: Discovery to Lost.
    await shown(screen(page).locator('[data-action="move-deal"]')).first().focus();
    await page.keyboard.press('Enter');
    const keySheet = shown(page.getByTestId('move-sheet')).first();
    await expect(keySheet).toBeVisible();
    expect((await moveOptions(keySheet)).enabled).toEqual(allowedFrom(S_DISCOVERY.id));
    await keySheet.locator(`[data-move-to="${S_LOST.id}"]`).first().focus();
    const toLost = page.waitForRequest((request) => isMoveOf(request, D_Q1.id));
    await page.keyboard.press('Enter');
    expect(json((await toLost).postDataJSON())).toEqual({ version: D_Q1.version + 1, toStageId: S_LOST.id });
    await expect.poll(async () => visibleText(field(page, 'stage'))).toContain(S_LOST.name);
    await expect(shown(screen(page).locator('[data-testid="stage-path"] [aria-current="step"]')), 'a lost deal is drawn on a path step').toHaveCount(0);
    expect(mock.writes.map((write) => write.status)).toEqual([200, 200]);
  });

  test('a gated stage opens the prompt: met requirements shown met, the rest filled and sent in the same move; the checks follow @p06-deal @p06-deal-requirements', async ({ page }) => {
    const mock = await openDeal(page, D_P1.id);
    await moveTo(page, S_NEGOTIATION.id);
    const dialog = await prompt(page);
    await expect(requirement(dialog, R_AMOUNT.id), 'a met requirement is asked again').toHaveAttribute('data-met', 'true');
    await expect(requirement(dialog, R_CLOSE.id)).toHaveAttribute('data-met', 'false');
    await expect(requirement(dialog, R_QUOTE.id)).toHaveAttribute('data-met', 'false');
    expect(await visibleText(requirement(dialog, R_QUOTE.id))).toContain(String(R_QUOTE.label));
    await expectSaysOneOf(requirement(dialog, R_CLOSE.id), dealLabels('.field.expectedCloseDate'), 'the close-date requirement');
    await expect(shown(dialog.locator(`[data-requirement-input="${R_AMOUNT.id}"]`)), 'a met field is offered for editing').toHaveCount(0);
    const confirm = dialog.locator('[data-action="confirm-move"]').first();
    if (!(await isDisabled(confirm))) await confirm.click();
    await expect(dialog).toBeVisible();
    await requirementInput(dialog, R_CLOSE.id).fill('2026-11-20');
    await requirementInput(dialog, R_QUOTE.id).check();
    const sent = page.waitForRequest((request) => isMoveOf(request, D_P1.id));
    await confirm.click();
    expect(json((await sent).postDataJSON())).toEqual({ version: D_P1.version, toStageId: S_NEGOTIATION.id, fields: { expectedCloseDate: '2026-11-20' }, checks: [R_QUOTE.id] });
    expect(mock.writes, 'an unfinished prompt was sent').toHaveLength(1);
    await expect.poll(async () => visibleText(field(page, 'stage'))).toContain(S_NEGOTIATION.name);
    await expect.poll(() => checkIds(page)).toEqual([R_BUDGET.id, R_QUOTE.id]);
    expect(await visibleText(shown(screen(page).locator(`[data-check="${R_QUOTE.id}"] [data-checked-by]`)).first())).toContain(ME.displayName);

    // Contract needs a primary contact, picked by name from the deal's programme only.
    await moveTo(page, S_CONTRACT.id);
    const contract = await prompt(page);
    await expect(requirement(contract, R_CONTACT.id)).toHaveAttribute('data-met', 'false');
    await requirementInput(contract, R_CONTACT.id).fill('alpha');
    const option = shown(page.locator(`[data-picker-option="${C_ALPHA.id}"]`)).first();
    await expect(option).toBeVisible();
    await expect(shown(page.locator(`[data-picker-option="${C_ALPHA_ELSEWHERE.id}"]`)), 'the picker offered another programme’s contact').toHaveCount(0);
    await option.click();
    await requirementInput(contract, R_PO.id).check();
    const toContract = page.waitForRequest((request) => isMoveOf(request, D_P1.id));
    await contract.locator('[data-action="confirm-move"]').first().click();
    expect(json((await toContract).postDataJSON())).toEqual({ version: D_P1.version + 1, toStageId: S_CONTRACT.id, fields: { primaryContactId: C_ALPHA.id }, checks: [R_PO.id] });
    await expect(related(page, 'contact').locator(`a[href="/contacts/${C_ALPHA.id}"]`)).toHaveCount(1);
    await expectNoIdsAnywhere(page, 'after the requirement prompt');
  });

  test('a 422 names the unmet requirements by label, learning a new one by re-reading the pipeline, and is never retried @p06-deal @p06-deal-unmet', async ({ page }) => {
    const mock = await openDeal(page, D_Q1.id, { requirementDrift: true });
    const answered = page.waitForResponse((response) => isMoveOf(response.request(), D_Q1.id));
    await moveTo(page, S_DISCOVERY.id);
    expect((await answered).status()).toBe(422);
    await expect(shown(page.getByRole('alert')).first()).toContainText(String(R_DRIFT.label));
    expect(mock.pipelineReads.length, 'the pipeline was not re-read to name the new requirement').toBeGreaterThanOrEqual(2);
    expect(await visibleText(field(page, 'stage'))).toContain(S_QUALIFIED.name);
    await expectNoIdsAnywhere(page, 'the requirements refusal');
    expect(mock.writes).toHaveLength(1);
    await page.keyboard.press('Escape');
    await moveTo(page, S_DISCOVERY.id);
    const dialog = await prompt(page);
    expect(await visibleText(requirement(dialog, R_DRIFT.id))).toContain(String(R_DRIFT.label));
    await requirementInput(dialog, R_DRIFT.id).check();
    const sent = page.waitForRequest((request) => isMoveOf(request, D_Q1.id));
    await dialog.locator('[data-action="confirm-move"]').first().click();
    expect(json((await sent).postDataJSON())).toEqual({ version: D_Q1.version, toStageId: S_DISCOVERY.id, checks: [R_DRIFT.id] });
    await expect.poll(async () => visibleText(field(page, 'stage'))).toContain(S_DISCOVERY.name);
    expect(mock.writes.map((write) => write.status)).toEqual([422, 200]);
  });

  test('409 transition_not_allowed and 403s are translated messages, never retried; a required field the caller cannot read is a lock @p06-deal @p06-deal-move-refused', async ({ page }) => {
    let mock = await openDeal(page, D_Q1.id, { transitionDrift: true });
    let answered = page.waitForResponse((response) => isMoveOf(response.request(), D_Q1.id));
    await moveTo(page, S_DISCOVERY.id);
    expect((await answered).status()).toBe(409);
    const labels = [EN['records.error.transition_not_allowed'] ?? '', ...dealLabels('.transition_not_allowed', '.transitionNotAllowed')].filter((text) => text !== '');
    expect(labels.length, 'en.json has no label for transition_not_allowed').toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const texts = await shown(page.getByRole('alert')).evaluateAll((elements) => elements.map((element) => element.textContent ?? ''));
        return texts.some((text) => labels.some((label) => text.includes(label)));
      }, { message: 'no alert says the transition is not allowed' })
      .toBe(true);
    expect(await visibleText(field(page, 'stage')), 'the stage did not stay where the server says').toContain(S_QUALIFIED.name);
    await page.keyboard.press('Escape');
    const next = page.waitForRequest((request) => isMoveOf(request, D_Q1.id));
    await moveTo(page, S_LOST.id);
    expect(json((await next).postDataJSON()).toStageId, 'the refused move was retried').toBe(S_LOST.id);
    expect(mock.writes.map((write) => write.status)).toEqual([409, 200]);
    await closeDeal(page);

    // An agent moving somebody else's deal: the API's 403 in translated copy.
    mock = await openDeal(page, D_Q_OTHER.id, { role: 'agent', query: '?locale=en-XA' });
    answered = page.waitForResponse((response) => isMoveOf(response.request(), D_Q_OTHER.id));
    await moveTo(page, S_DISCOVERY.id);
    expect((await answered).status()).toBe(403);
    expect(await visibleText(shown(page.getByRole('alert')).first()), 'the refusal is the server message, not translated copy').toMatch(PSEUDO);
    expect(mock.writes).toHaveLength(1);
    await closeDeal(page);

    // PIPELINE_TWO: Negotiation requires an amount and a close date the caller cannot read.
    mock = await openDeal(page, E_P1.id);
    await moveTo(page, T_NEGOTIATION.id);
    const dialog = await prompt(page);
    for (const id of [T_NEGOTIATION.requirements[0]?.id ?? '', T_NEGOTIATION.requirements[1]?.id ?? '']) {
      await expect(requirement(dialog, id), 'a withheld required field is not a lock').toHaveAttribute('data-locked', 'true');
      await expect(lockIcon(requirement(dialog, id))).toHaveCount(1);
      await expect(shown(dialog.locator(`[data-requirement-input="${id}"]`)), 'a lock is offered for filling').toHaveCount(0);
    }
    await requirementInput(dialog, T_R_QUOTE.id).check();
    answered = page.waitForResponse((response) => isMoveOf(response.request(), E_P1.id));
    await dialog.locator('[data-action="confirm-move"]').first().click();
    const response = await answered;
    expect(response.status()).toBe(403);
    expect(json(response.request().postDataJSON())).toEqual({ version: E_P1.version, toStageId: T_NEGOTIATION.id, checks: [T_R_QUOTE.id] });
    const alert = shown(page.getByRole('alert')).first();
    await expectSaysOneOf(alert, dealLabels('.field.amount'), 'the refusal naming the amount');
    await expectSaysOneOf(alert, dealLabels('.field.expectedCloseDate'), 'the refusal naming the close date');
    await expectNoIdsAnywhere(page, 'the field_not_editable refusal');
    await page.keyboard.press('Escape');
    expect(await visibleText(field(page, 'stage'))).toContain(T_PROPOSAL.name);
    expect(mock.writes).toHaveLength(1);
  });

  test('a stale move re-reads and rebases the prompt (D-L102); a prompt-less stale move is never resent by itself @p06-deal @p06-deal-move-stale', async ({ page }) => {
    let mock = await openDeal(page, D_P1.id, { concurrent: { dealId: D_P1.id, changes: [{ expectedCloseDate: '2026-11-30' }] } });
    await moveTo(page, S_NEGOTIATION.id);
    let dialog = await prompt(page);
    await requirementInput(dialog, R_CLOSE.id).fill('2026-11-20');
    await requirementInput(dialog, R_QUOTE.id).check();
    const lost = page.waitForResponse((response) => isMoveOf(response.request(), D_P1.id));
    await dialog.locator('[data-action="confirm-move"]').first().click();
    expect((await lost).status()).toBe(409);
    await expect.poll(() => dealReReadAfterWrite(mock, D_P1.id), { message: 'the deal was not re-read after the 409' }).toBe(true);
    dialog = await prompt(page);
    await expect(requirementInput(dialog, R_CLOSE.id), 'the typed close date was lost').toHaveValue('2026-11-20');
    await expect(requirementInput(dialog, R_QUOTE.id)).toBeChecked();
    await expect(shown(requirement(dialog, R_CLOSE.id).locator('[data-conflict]')).first(), 'no "changed by someone else" note').toBeVisible();
    expect(mock.writes).toHaveLength(1);
    const second = page.waitForRequest((request) => isMoveOf(request, D_P1.id));
    await dialog.locator('[data-action="confirm-move"]').first().click();
    expect(json((await second).postDataJSON())).toEqual({ version: D_P1.version + 1, toStageId: S_NEGOTIATION.id, fields: { expectedCloseDate: '2026-11-20' }, checks: [R_QUOTE.id] });
    await expect.poll(async () => visibleText(field(page, 'stage'))).toContain(S_NEGOTIATION.name);
    await closeDeal(page);

    mock = await openDeal(page, D_Q1.id, { concurrent: { dealId: D_Q1.id, changes: [{ nextStep: 'Changed at another desk' }] } });
    const refused = page.waitForResponse((response) => isMoveOf(response.request(), D_Q1.id));
    await moveTo(page, S_DISCOVERY.id);
    expect((await refused).status()).toBe(409);
    await expect(shown(page.getByRole('alert')).first()).toBeVisible();
    await expect.poll(() => dealReReadAfterWrite(mock, D_Q1.id)).toBe(true);
    await expect.poll(async () => visibleText(field(page, 'nextStep'))).toContain('Changed at another desk');
    expect(await visibleText(field(page, 'stage'))).toContain(S_QUALIFIED.name);
    await page.keyboard.press('Escape');
    const again = page.waitForRequest((request) => isMoveOf(request, D_Q1.id));
    await moveTo(page, S_DISCOVERY.id);
    expect(json((await again).postDataJSON())).toEqual({ version: D_Q1.version + 1, toStageId: S_DISCOVERY.id });
    expect(mock.writes.map((write) => write.status)).toEqual([409, 200]);
  });
});

// ===========================================================================
// The timeline (T-0111's listDealTimeline)
// ===========================================================================

test.describe('the deal timeline', () => {
  test('every item once, in served order; field changes by name only; actors by name; activities by type @p06-deal @p06-deal-timeline', async ({ page }) => {
    const mock = await openDeal(page, X_FULL.id);
    const served = timelineOf(X_FULL.id);
    await expect(item(page, String(served[0]?.id))).toBeVisible();
    const limit = mock.timelineReads[0]?.searchParams.get('limit');
    if (limit !== null && limit !== undefined) expect(Number(limit), 'the first timeline page is too small for the journeys').toBeGreaterThanOrEqual(served.length);
    expect(await renderedItemIds(page), 'the timeline is not the served items, once each, newest first').toEqual(served.map((entry) => entry.id));

    for (const entry of served) {
      const row = item(page, String(entry.id));
      await expect(row).toHaveAttribute('data-item-type', String(entry.type));
      const instants = await row.locator('time[datetime]').evaluateAll((times) => times.map((time) => Date.parse(time.getAttribute('datetime') ?? '')));
      expect(instants, `${String(entry.id)} draws no <time datetime> for when it happened`).toContain(Date.parse(String(entry.occurredAt)));
      if (entry.type === 'field_changed') await expectSaysOneOf(row, dealLabels(`.field.${String(entry.field)}`), `the ${String(entry.field)} item`);
      const actor = row.locator('[data-actor]').first();
      await expect(actor, `${String(entry.id)} names no actor`).toBeVisible();
      const who = entry.actor as { displayName: string } | null;
      if (who !== null) await expect(actor).toContainText(who.displayName);
    }
    expect(new Set(served.filter((entry) => entry.type === 'field_changed').map((entry) => entry.field)), 'the fixture no longer covers every field name').toEqual(new Set(TIMELINE_FIELDS));

    // null is the system: one label, never a person.
    const system = new Set<string>();
    for (const entry of [ITEM_OWNER, ITEM_CONTACT]) system.add(await visibleText(item(page, entry.id).locator('[data-actor]').first()));
    expect(system.size, 'the system is drawn more than one way').toBe(1);
    expect([...system][0] ?? '').toMatch(/system/i);
    await expect(item(page, ITEM_NOTE.id).locator('[data-actor]').first(), 'a former member who acted is named (D-L81)').toContainText(FORMER_MEMBER.displayName);

    // By name only: the current value is never drawn on a change as if it were the change.
    expect(digits(await visibleText(item(page, ITEM_AMOUNT.id))), 'the amount item shows an amount').not.toContain('1500000015');
    expect(await visibleText(item(page, ITEM_OWNER.id)), 'an owner change names an owner').not.toContain(OTHER.displayName);
    expect(await visibleText(item(page, ITEM_CONTACT.id)), 'a contact change names the contact').not.toContain(C_ALPHA.displayName);
    expect(await visibleText(item(page, ITEM_ACCOUNT.id)), 'an account change names the account').not.toContain(A_PHARMACY.name);
    expect(await visibleText(item(page, ITEM_NAME.id)), 'a name change shows the name').not.toContain(X_FULL.name);
    expect(await visibleText(item(page, ITEM_NEXT_STEP.id)), 'a next-step change shows the next step').not.toContain(String(X_FULL.nextStep));
    const stageItem = await visibleText(item(page, ITEM_STAGE.id));
    for (const stage of [S_QUALIFIED, S_DISCOVERY, S_PROPOSAL, S_NEGOTIATION, S_CONTRACT]) {
      expect(stageItem, `the stage item names ${stage.name} (by name only until a contract edit, T-0111 R8)`).not.toContain(stage.name);
    }

    await expectSaysOneOf(item(page, ITEM_TASK.id), activityTypeLabels('task'), 'the task item');
    await expectSaysOneOf(item(page, ITEM_NOTE.id), activityTypeLabels('note'), 'the note item');
    await expectSaysOneOf(item(page, ITEM_CALL.id), activityTypeLabels('call'), 'the call item');
    await expectSaysOneOf(item(page, ITEM_MEETING.id), activityTypeLabels('meeting'), 'the meeting item');
    await expect(item(page, ITEM_CALL.id)).toContainText(String(ITEM_CALL.activity?.subject));
    await expect(item(page, ITEM_CALL.id)).toContainText(String(ITEM_CALL.activity?.body));
    await expect(item(page, ITEM_NOTE.id)).toContainText(String(ITEM_NOTE.activity?.body));
    const due = await visibleText(item(page, ITEM_TASK.id));
    // Due 2026-10-14T14:00Z is 15:00 in Lagos (WAT, UTC+1).
    expect(due, 'the due time is not shown in the browser’s zone').toMatch(/\b15[:.]00\b|\b3[:.]00\s?[Pp]\.?[Mm]/);
    expect(due, 'the due time is shown in UTC').not.toMatch(/\b14[:.]00\b|\b2[:.]00\s?[Pp]\.?[Mm]/);
    const meetingTimes = await item(page, ITEM_MEETING.id).locator('time[datetime]').evaluateAll((times) => times.map((time) => Date.parse(time.getAttribute('datetime') ?? '')));
    expect(meetingTimes, 'the meeting does not say when it starts').toContain(Date.parse(String(ITEM_MEETING.activity?.startsAt)));

    const all = await visibleText(shown(screen(page).getByTestId('timeline')).first());
    expect(all, 'raw values leaked into the timeline').not.toMatch(/\bnull\b|\bundefined\b|\[object Object\]|\btrue\b|\bfalse\b|\bredacted\b|\bti_\w+|stageId|ownerUserId|primaryContactId/);
    expect(all, 'a raw timestamp was printed').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    await expect(shown(screen(page).getByTestId('timeline-load-older')), 'a single page offers "load older"').toHaveCount(0);
    await expectNoIdsAnywhere(page, 'the timeline');
  });

  test('"load older" pages by keyset, echoes the cursor exactly, keeps it out of the address bar, and shows no total @p06-deal @p06-deal-timeline-paging', async ({ page }) => {
    await page.clock.setFixedTime(new Date(NOW));
    const mock = await installDealMock(page);
    active = mock;
    const served = timelineOf(X_LONG.id);
    const firstPage = page.waitForResponse((response) => isDealTimeline(response.request(), X_LONG.id) && !new URL(response.url()).searchParams.has('cursor'));
    expect((await page.goto(`${pipelineUrl()}/deals/${X_LONG.id}`))?.status()).toBe(200);
    await expect(screen(page)).toHaveAttribute('data-record-state', 'ready');
    let next = ((await (await firstPage).json()) as { nextCursor: string | null }).nextCursor;
    expect(next, 'the long timeline has no second page').not.toBeNull();
    await expect(item(page, String(served[0]?.id))).toBeVisible();
    await expect(shown(screen(page).getByText(LONG_OLDEST_SUBJECT))).toHaveCount(0);
    let pages = 1;
    while (next !== null && pages <= LONG_TIMELINE_LENGTH) {
      const more = shown(screen(page).getByTestId('timeline-load-older')).first();
      await expect(more, 'there is more history and no "load older"').toBeEnabled();
      const cursor: string = next;
      const answered = page.waitForResponse((candidate) => isDealTimeline(candidate.request(), X_LONG.id) && new URL(candidate.url()).searchParams.has('cursor'));
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
    await expectNoUsable(shown(screen(page).getByTestId('timeline-load-older')), '"load older" on the last page');
    const text = await visibleText(screen(page));
    expect(text, 'a total was drawn').not.toMatch(new RegExp(`\\b${LONG_TIMELINE_LENGTH}\\b`));
    expect(text).not.toMatch(/\b\d+\s+of\s+\d+\b/i);
    expect(TIMELINE_DEFAULT_LIMIT).toBeLessThan(LONG_TIMELINE_LENGTH);
  });

  test('field security: a withheld deal link shows no activity and refuses a link; a write-only link is never drawn from the create; withheld field items are not invented @p06-deal @p06-deal-timeline-withheld', async ({ page }) => {
    let mock = await openDeal(page, X_FULL.id, { activityDealLink: 'hidden' });
    const fieldOnly = timelineOf(X_FULL.id, [], 'hidden');
    await expect(item(page, String(fieldOnly[0]?.id))).toBeVisible();
    expect(await renderedItemIds(page)).toEqual(fieldOnly.map((entry) => entry.id));
    await expect(shown(screen(page).locator('[data-timeline-item][data-item-type="activity"]'))).toHaveCount(0);
    const note = await openLog(page, 'note');
    await note.locator('[data-field-input="body"]').first().fill('Linked or not at all.');
    const refused = page.waitForResponse((response) => isCreateActivity(response.request()));
    await note.locator('[data-action="save-activity"]').first().click();
    expect((await refused).status(), 'the link refusal did not come from the API').toBe(403);
    await expect(shown(note.getByRole('alert')).first()).toBeVisible();
    await expect(note.locator('[data-field-input="body"]').first()).toHaveValue('Linked or not at all.');
    expect(await renderedItemIds(page)).toEqual(fieldOnly.map((entry) => entry.id));
    expect(mock.writes, 'the refused activity was retried').toHaveLength(1);
    await closeDeal(page);

    // Write-only: the create succeeds, but what the timeline serves is what is drawn (R17).
    mock = await openDeal(page, X_FULL.id, { activityDealLink: 'writeOnly' });
    const form = await openLog(page, 'note');
    await form.locator('[data-field-input="body"]').first().fill('Logged where I cannot see it.');
    const created = page.waitForResponse((response) => isCreateActivity(response.request()));
    await form.locator('[data-action="save-activity"]').first().click();
    expect((await created).status()).toBe(201);
    await expect.poll(() => timelineReReadAfterWrite(mock, X_FULL.id), { message: 'the timeline was not re-read after the create' }).toBe(true);
    await expect(shown(screen(page).locator(`[data-activity-id="${String(NEW_ACTIVITY_IDS[0])}"]`)), 'an activity the timeline does not serve was drawn from the create').toHaveCount(0);
    // The create added nothing the timeline serves: it is still the field items alone.
    expect(await renderedItemIds(page)).toEqual(timelineOf(X_FULL.id, [], 'writeOnly').map((entry) => entry.id));
    await closeDeal(page);

    // PROGRAMME_TWO: the items for withheld fields are not served, and nothing stands in for them.
    await openDeal(page, E_Q1.id);
    const servedItems = timelineOf(E_Q1.id, withheldIn(PROGRAMME_TWO.id));
    await expect(item(page, String(servedItems[0]?.id))).toBeVisible();
    expect(await renderedItemIds(page)).toEqual(servedItems.map((entry) => entry.id));
    const copy = await visibleText(shown(screen(page).getByTestId('timeline')).first());
    for (const name of ['amount', 'ownerUserId', 'expectedCloseDate']) {
      for (const label of dealLabels(`.field.${name}`)) expect(copy, `a ${name} change was invented on the timeline`).not.toContain(label);
    }
  });
});

// ===========================================================================
// Logging an activity on the deal (D-L129)
// ===========================================================================

test.describe('activities on the deal', () => {
  test('a note, a task and a call are logged once, linked with dealId and the deal’s own contact and account, and appear on its timeline @p06-deal @p06-deal-log', async ({ page }) => {
    const mock = await openDeal(page, X_FULL.id, { holdWrites: true });
    const note = await openLog(page, 'note');
    await expectNoUsable(note.locator('[data-field-input="dueAt"]'), 'a due time on a note');
    await note.locator('[data-field-input="body"]').first().fill('Agreed to hold prices until Friday.');
    const save = note.locator('[data-action="save-activity"]').first();
    await expect(save).toHaveAttribute('data-requires-connection', /.*/);
    const posted = page.waitForRequest(isCreateActivity);
    await save.click();
    const body = json((await posted).postDataJSON());
    expect({ type: body.type, body: body.body, dealId: body.dealId, contactId: body.contactId, accountId: body.accountId }).toEqual({
      type: 'note',
      body: 'Agreed to hold prices until Friday.',
      dealId: X_FULL.id,
      contactId: C_ALPHA.id,
      accountId: A_PHARMACY.id,
    });
    expect(body.subject === undefined || body.subject === null, 'an empty subject was sent as text').toBe(true);
    expect(body.ownerUserId === undefined || body.ownerUserId === ME.id).toBe(true);
    expect(keysOf(body).filter((key) => !['type', 'subject', 'body', 'dealId', 'contactId', 'accountId', 'ownerUserId'].includes(key)), 'the note carried something else').toEqual([]);
    await expect(save, 'the save stays usable while the create is in flight').toBeDisabled();
    mock.releaseWrites();
    const logged = shown(screen(page).locator(`[data-activity-id="${String(NEW_ACTIVITY_IDS[0])}"]`)).first();
    await expect(logged, 'the new note is not on the deal timeline').toBeVisible();
    await expect(logged).toContainText('Agreed to hold prices until Friday.');
    await expect(logged.locator('[data-actor]').first()).toContainText(ME.displayName);
    expect(timelineReReadAfterWrite(mock, X_FULL.id), 'the timeline was not re-read after the create (R17)').toBe(true);

    const task = await openLog(page, 'task');
    await task.locator('[data-field-input="subject"]').first().fill('Send the signed contract');
    const due = task.locator('[data-field-input="dueAt"]').first();
    await expect(due).toHaveAttribute('type', 'datetime-local');
    // 15:00 on a Lagos desk is 14:00 UTC.
    await due.fill('2026-10-16T15:00');
    const taskPost = page.waitForRequest(isCreateActivity);
    await task.locator('[data-action="save-activity"]').first().click();
    const taskBody = json((await taskPost).postDataJSON());
    expect([taskBody.type, taskBody.dealId]).toEqual(['task', X_FULL.id]);
    expect(Date.parse(String(taskBody.dueAt)), 'the due time was not converted from the browser’s zone').toBe(Date.parse('2026-10-16T14:00:00.000Z'));
    expect(String(taskBody.dueAt)).toMatch(/Z$/);
    await expect(shown(screen(page).locator(`[data-activity-id="${String(NEW_ACTIVITY_IDS[1])}"]`)).first()).toBeVisible();

    const callForm = await openLog(page, 'call');
    await callForm.locator('[data-field-input="subject"]').first().fill('Called the procurement desk');
    const callPost = page.waitForRequest(isCreateActivity);
    await callForm.locator('[data-action="save-activity"]').first().click();
    expect(json((await callPost).postDataJSON())).toMatchObject({ type: 'call', dealId: X_FULL.id, contactId: C_ALPHA.id, accountId: A_PHARMACY.id });
    await expect(shown(screen(page).locator(`[data-activity-id="${String(NEW_ACTIVITY_IDS[2])}"]`)).first()).toBeVisible();
    const newest = await shown(screen(page).locator('[data-timeline-item]')).evaluateAll((items) => items.slice(0, 3).map((element) => element.getAttribute('data-activity-id') ?? ''));
    expect(newest, 'what was just logged is not at the top of the timeline').toEqual([NEW_ACTIVITY_IDS[2], NEW_ACTIVITY_IDS[1], NEW_ACTIVITY_IDS[0]]);
    expect(mock.writes.map((write) => `${write.method} ${String(write.status)}`)).toEqual(['POST 201', 'POST 201', 'POST 201']);
    await closeDeal(page);

    // One target only when the deal has one.
    for (const [row, expected] of [
      [D_N2, { contactId: C_ALPHA.id }],
      [D_D1, { accountId: A_PHARMACY.id }],
    ] as const) {
      await openDeal(page, row.id);
      const form = await openLog(page, 'note');
      await form.locator('[data-field-input="body"]').first().fill('One target only.');
      const sent = page.waitForRequest(isCreateActivity);
      await form.locator('[data-action="save-activity"]').first().click();
      const sentBody = json((await sent).postDataJSON());
      expect({ contactId: sentBody.contactId ?? undefined, accountId: sentBody.accountId ?? undefined, dealId: sentBody.dealId }).toEqual({ ...expected, dealId: row.id });
      await closeDeal(page);
    }
  });

  test('a deal with neither contact nor account offers no composer and says why (D-L129) @p06-deal @p06-deal-log-no-target', async ({ page }) => {
    const mock = await openDeal(page, D_Q1.id);
    await expectNoUsable(screen(page).locator('[data-action="log-activity"]'), 'logging an activity against nothing');
    const why = shown(screen(page).getByTestId('activity-no-target')).first();
    await expect(why, 'the screen does not say why nothing can be logged').toBeVisible();
    expect(await visibleText(why)).not.toBe('');
    expect(mock.writes).toEqual([]);
    await closeDeal(page);

    // A contact and an account the caller cannot see are not targets either.
    await openDeal(page, X_FULL.id, { withheld: ['primaryContactId', 'accountId'] });
    await expectNoUsable(screen(page).locator('[data-action="log-activity"]'), 'logging an activity against withheld targets');
    await expect(shown(screen(page).getByTestId('activity-no-target')).first()).toBeVisible();
  });

  test('a refused activity is a translated alert; the form and the typing are kept, and nothing is added @p06-deal @p06-deal-log-refused', async ({ page }) => {
    const mock = await openDeal(page, X_FULL.id, { role: 'qa_analyst', query: '?locale=en-XA' });
    const before = await renderedItemIds(page);
    const note = await openLog(page, 'note');
    await note.locator('[data-field-input="body"]').first().fill('A reader tries to log.');
    const answered = page.waitForResponse((response) => isCreateActivity(response.request()));
    await note.locator('[data-action="save-activity"]').first().click();
    expect((await answered).status()).toBe(403);
    const alert = shown(note.getByRole('alert')).first();
    await expect(alert).toBeVisible();
    expect(await visibleText(alert), 'the refusal is the server message, not translated copy').toMatch(PSEUDO);
    await expect(note.locator('[data-field-input="body"]').first()).toHaveValue('A reader tries to log.');
    expect(await renderedItemIds(page), 'a refused activity was drawn').toEqual(before);
    expect(mock.writes).toHaveLength(1);
  });
});

// ===========================================================================
// Not found (D-L69, D-L115) and states
// ===========================================================================

test('a deal out of scope or missing is the plain not-found page; a malformed id is a real 404 that reads nothing @p06-deal @p06-deal-not-found', async ({ page }) => {
  const mock = await installDealMock(page);
  active = mock;
  const title = EN['notFound.title'] ?? '<notFound.title>';
  const explanation = EN['notFound.body'] ?? '<notFound.body>';
  const headings: string[] = [];
  // `move` is a concrete API path segment: an id that is not a uuid must never become a call.
  for (const id of [OUT_OF_SCOPE_DEAL_ID, NO_SUCH_DEAL_ID, 'not-a-uuid', 'move']) {
    const readsBefore = mock.requests.length;
    const response = await page.goto(`${pipelineUrl()}/deals/${id}`);
    if (UUID.test(id)) {
      // R1: the route never reads the deal on the server, so a well-formed id answers 200 and the API decides.
      expect(response?.status(), `/deals/${id} is not answered 200`).toBe(200);
      await expect(shown(page.getByTestId('record-not-found')).first(), `/deals/${id} is not the not-found page`).toBeVisible();
      await expect.poll(() => mock.dealReads.some((url) => url.pathname === `/api/v1/deals/${id}`), { message: `/deals/${id} never asked the API` }).toBe(true);
    } else {
      expect(response?.status(), `/deals/${id}: a malformed id is not a real 404`).toBe(404);
      const calls = mock.requests.slice(readsBefore).filter((url) => /^\/api\/v1\/(deals|pipelines|activities)/.test(url.pathname));
      expect(calls.map((url) => url.pathname), `/deals/${id} reached the API`).toEqual([]);
    }
    const h1 = shown(page.getByRole('heading', { level: 1 })).first();
    await expect(h1).toHaveText(title);
    const whole = await visibleText(page.locator('body'));
    expect(whole).toContain(explanation);
    expect(whole, 'the access-denied frame was drawn').not.toMatch(/request access|access denied|belongs to/i);
    for (const programme of [PROGRAMME_ONE, PROGRAMME_TWO]) expect(whole, 'a programme was named on the not-found page').not.toContain(programme.name);
    await expect(page.locator('[data-testid="stage-path"], [data-timeline-item], [data-action="edit-deal"], [data-action="move-deal"], [data-action="log-activity"]')).toHaveCount(0);
    await expect(page.getByTestId('record-unavailable')).toHaveCount(0);
    await expectNoIdsAnywhere(page, `the not-found page for ${id}`);
    headings.push(await visibleText(h1));
  }
  expect(new Set(headings).size, 'the not-found page differs between out of scope, missing and malformed').toBe(1);
  expect(mock.writes).toEqual([]);
});

test.describe('states', () => {
  test('loading is a skeleton, never not-found, empty or the deal, until the deal arrives @p06-deal @p06-deal-states', async ({ page }) => {
    const mock = await openDeal(page, X_FULL.id, { hold: true });
    try {
      await expect(screen(page)).toHaveAttribute('data-record-state', 'loading');
      expect(await shown(screen(page).getByTestId('record-skeleton')).count(), 'no skeleton').toBeGreaterThan(0);
      await expect(page.locator('[data-testid="record-not-found"], [data-testid="record-unavailable"], [data-testid="timeline-empty"], [data-timeline-item]')).toHaveCount(0);
      expect(await visibleText(screen(page))).not.toContain(X_FULL.name);
    } finally {
      mock.release();
    }
    await expect(screen(page)).toHaveAttribute('data-record-state', 'ready');
    await expect(shown(screen(page).getByTestId('record-skeleton'))).toHaveCount(0);
    await expect(heading(page)).toContainText(X_FULL.name);
  });

  test('a failed read says the server could not be reached, never "not found" @p06-deal @p06-deal-states', async ({ page }) => {
    await openDeal(page, X_FULL.id, { networkFailure: true });
    const unavailable = shown(page.getByTestId('record-unavailable')).first();
    await expect(unavailable).toBeVisible();
    expect(await visibleText(unavailable)).not.toBe('');
    await expect(page.getByTestId('record-not-found')).toHaveCount(0);
  });

  test('a failed timeline is an error, never "no history", and the deal still shows; an empty timeline is its own state @p06-deal @p06-deal-states', async ({ page }) => {
    await openDeal(page, X_FULL.id, { timelineFailure: true });
    await expect(heading(page)).toContainText(X_FULL.name);
    await expect(shown(screen(page).getByTestId('timeline-error')).first()).toBeVisible();
    await expect(shown(screen(page).locator('[data-testid="timeline-empty"], [data-timeline-item]'))).toHaveCount(0);
    await closeDeal(page);

    await openDeal(page, D_D1.id);
    const empty = shown(screen(page).getByTestId('timeline-empty')).first();
    await expect(empty).toBeVisible();
    expect(await visibleText(empty)).not.toBe('');
    await expect(shown(screen(page).locator('[data-testid="timeline-error"], [data-timeline-item]'))).toHaveCount(0);
  });
});

// ===========================================================================
// Offline (D-P21, D-L64)
// ===========================================================================

test('offline: every write is disabled, nothing is queued or sent, and nothing is kept on the device @p06-deal @p06-deal-offline', async ({ page }) => {
  const mock = await openDeal(page, X_FULL.id);
  for (const selector of ['[data-action="edit-deal"]', '[data-action="move-deal"]', '[data-action="assign-to-me"]']) {
    await expect(shown(screen(page).locator(selector)).first(), `${selector} is not marked as needing a connection`).toHaveAttribute('data-requires-connection', /.*/);
  }
  await expect(shown(screen(page).locator('[data-action="log-activity"]')).first()).toHaveAttribute('data-requires-connection', /.*/);

  await page.context().setOffline(true);
  try {
    const banner = shown(page.getByTestId('offline-banner')).first();
    await expect(banner).toBeVisible();
    expect(await visibleText(banner), 'the banner does not say when the deal last synced').toMatch(/\d{1,2}[:.]\d{2}/);
    expect(await copyText(page.locator('body')), 'an offline queue is offered').not.toMatch(/queued|sync queue|will sync|saved on this (phone|device)/i);
    const needsConnection = page.locator('[data-requires-connection]');
    const count = await needsConnection.count();
    expect(count, 'nothing is marked as needing a connection').toBeGreaterThan(3);
    for (let index = 0; index < count; index += 1) {
      expect(await isDisabled(needsConnection.nth(index)), `a control that needs a connection is enabled offline (#${index})`).toBe(true);
    }
    await expect(heading(page), 'the deal was dropped when the connection went').toContainText(X_FULL.name);
    const stored = await deviceStorage(page);
    expect(stored.cachedApi, 'an API response was put in Cache Storage').toEqual([]);
    expect(stored.databases, 'an IndexedDB database was opened').toEqual([]);
    for (const needle of needles()) expect(stored.dump.includes(needle), `"${needle}" was written to device storage`).toBe(false);
  } finally {
    await page.context().setOffline(false);
  }
  await expect(shown(page.getByTestId('offline-banner'))).toHaveCount(0);
  const sent = page.waitForRequest((request) => isUpdateDeal(request, X_FULL.id));
  await shown(screen(page).locator('[data-action="assign-to-me"]')).first().click();
  await sent;
  expect(mock.writes.map((write) => write.path), 'a write was sent or queued while offline').toEqual([`/api/v1/deals/${X_FULL.id}`]);
});

// ===========================================================================
// Hidden until their modules exist (D-L88's hidden list)
// ===========================================================================

test('no AI risk, products, FX or US$, VAT, quotes, approvals, contact roles, competitors, forecast, territory, deal number, attachments, WhatsApp or Undo @p06-deal @p06-deal-hidden', async ({ page }) => {
  await openDeal(page, X_FULL.id);
  const banned: readonly (readonly [RegExp, string])[] = [
    [/US\$|\bUSD\b|≈|exchange rate|\bFX\b|rate locked|request extension/i, 'US$ or an FX rate'],
    [/\bAI\b|deal risk|win chance/i, 'AI risk'],
    [/\bproducts?\b|price book|add product/i, 'products'],
    [/\bVAT\b|subtotal|total incl/i, 'VAT and totals'],
    [/\bquotes?\b(?!\s+sent)|new quote/i, 'quotes'],
    [/approv|cancel request|submit for/i, 'approvals'],
    [/competitor|contact roles?|champion|decision maker/i, 'contact roles or competitors'],
    [/\bforecast\b|\bcommit\b|\brenewal\b/i, 'the forecast category or the deal type'],
    [/territor|lead source/i, 'territory or lead source'],
    [/\bDL-\d/i, 'a deal number'],
    [/attach|upload/i, 'attachments'],
    [/whatsapp|invite .+ to a call/i, 'WhatsApp'],
    [/\bundo\b/i, 'Undo'],
  ];
  const check = async (where: string, root: Locator) => {
    const copy = await copyText(root);
    for (const [pattern, what] of banned) expect(copy, `${what} is drawn on ${where}`).not.toMatch(pattern);
    await expect(shown(root.locator('[aria-hidden="true"]', { hasText: /^\s*(auto_awesome|currency_exchange|chat|upload_file|approval|request_quote|menu_book)\s*$/ })), `a hidden feature’s icon on ${where}`).toHaveCount(0);
  };
  await check('the deal', page.locator('body'));
  await openMoveSheet(page);
  await check('the move sheet', page.locator('body'));
  await page.keyboard.press('Escape');
  await moveTo(page, S_CONTRACT.id);
  await check('the requirement prompt', await prompt(page));
  await page.keyboard.press('Escape');
  await check('the edit sheet', await openEdit(page));
  await page.keyboard.press('Escape');
  await check('the activity form', await openLog(page, 'note'));
});

// ===========================================================================
// Mobile (P06/06)
// ===========================================================================

test('at 360px the deal fits without sideways page scroll, passes axe, and the move sheet works @p06-deal @p06-deal-mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const mock = await openDeal(page, D_Q1.id);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow(), 'the deal scrolls the PAGE sideways at 360px (a stage-path scroller inside it is fine)').toBeLessThanOrEqual(0);
  await expectNoSeriousAxe(page, 'P06/06 at 360px');
  const sheet = await openMoveSheet(page);
  const box = await sheet.boundingBox();
  expect(box !== null && box.x >= 0 && box.x + box.width <= 361, 'the move sheet is wider than the screen').toBe(true);
  const sent = page.waitForRequest((request) => isMoveOf(request, D_Q1.id));
  await sheet.locator(`[data-move-to="${S_DISCOVERY.id}"]`).first().click();
  await sent;
  await expect.poll(async () => visibleText(field(page, 'stage'))).toContain(S_DISCOVERY.name);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await expectNoIdsAnywhere(page, 'the 360px deal');
  expect(mock.writes).toHaveLength(1);
});

// ===========================================================================
// i18n
// ===========================================================================

test('locale=en-XA renders every string as pseudo text, record data and times excepted @p06-deal @p06-deal-pseudo', async ({ page }) => {
  await openDeal(page, X_FULL.id, { query: '?locale=en-XA' });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  await expect(item(page, String(timelineOf(X_FULL.id)[0]?.id))).toBeVisible();
  const report = (root: Locator) =>
    root.evaluate((element, servedJson) => {
      const pseudo = (text: string) => /[·[\]äëïöüÄËÏÖÜ]/.test(text);
      const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length >= 2;
      const recordish = (text: string) => servedJson.includes(text) || servedJson.includes(JSON.stringify(text).slice(1, -1));
      // Money is Intl's, in the page's language ("NGN 1.00" carries letters), and so are the currency codes.
      const skipped = (node: Element | null) =>
        node === null ||
        node.closest('[aria-hidden="true"], [data-testid^="language-"], script, style, noscript, time, [data-field="amount"], [data-field="weightedAmount"], [data-field-input="currency"]') !== null;
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
    }, servedDealData());

  const whole = await report(page.locator('[data-shell="crm"]'));
  expect(whole.english, 'strings on the deal that did not come through i18n').toEqual([]);
  expect(whole.forged, 'UI copy marked data-record-text that is not served record data').toEqual([]);
  expect(whole.pseudoCount, 'almost no pseudo text: the check saw nothing').toBeGreaterThanOrEqual(10);
  const sheet = await openMoveSheet(page);
  expect((await report(sheet)).english, 'strings in the move sheet that did not come through i18n').toEqual([]);
  await page.keyboard.press('Escape');
  await moveTo(page, S_CONTRACT.id);
  const dialog = await prompt(page);
  const promptReport = await report(dialog);
  expect(promptReport.english, 'strings in the requirement prompt that did not come through i18n').toEqual([]);
  expect(promptReport.forged).toEqual([]);
  await page.keyboard.press('Escape');
  expect((await report(await openEdit(page))).english, 'strings in the edit sheet that did not come through i18n').toEqual([]);
  await page.keyboard.press('Escape');
  expect((await report(await openLog(page, 'task'))).english, 'strings in the activity form that did not come through i18n').toEqual([]);
});

// ===========================================================================
// Budget
// ===========================================================================

test.describe('/deals/[dealId] on the wire', () => {
  /**
   * WHY A 260,000-BYTE CEILING, BEFORE THE SCREEN EXISTS
   *
   * The same shell, fonts and records clients as its measured neighbours
   * (/accounts/[id] pinned at 245,000; /pipelines/[pipelineId] under the same
   * ceiling), plus a header, a stage path, an edit sheet, T-0109's move sheet
   * and prompt, a timeline and an activity form. 252,000 is a PLACEHOLDER: the
   * builder measures it on the first green run and the lead re-pins
   * DEAL_BUDGET_BYTES within 5% of that measurement (D-L118). The dialogs may
   * load when first opened (`next/dynamic`).
   */
  test('/deals/<id> stays inside its transferred-byte budget on the production build @p06-deal @p06-deal-budget', async ({ page }) => {
    // No fixed clock here: Playwright's fake clock replaces window.performance (D-L118).
    active = await installDealMock(page);
    const metrics = await measurePageLoad(page, `${pipelineUrl()}/deals/${X_FULL.id}`, 'default');
    const record = resolve(__dirname, '.artifacts', 'p06-deal-budget.json');
    mkdirSync(resolve(__dirname, '.artifacts'), { recursive: true });
    writeFileSync(record, `${JSON.stringify({ path: '/deals/[dealId]', transferredBytes: metrics.transferredBytes, budget: DEAL_BUDGET_BYTES }, null, 2)}\n`, 'utf8');
    // Bytes from `next dev` are not a budget (D-L28): prove this is the build.
    const html = await page.content();
    const built = readFileSync(resolve(__dirname, '..', '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
    expect(servedBuildId(html), 'webPipelineUrl is not serving the production build').toBe(built);
    // A 404 page is small: a budget met by the not-found page measures nothing.
    await expect(screen(page)).toBeVisible();
    await expect(heading(page)).toContainText(X_FULL.name);
    expect(DEAL_BUDGET_BYTES).toBeLessThan(300_000);
    assertWithinByteBudget('P06/05 the deal detail', metrics.transferredBytes, DEAL_BUDGET_BYTES);
  });

  test('/deals/<id> paints within 5 s at 256 kbps and 300 ms @p06-deal @p06-deal-budget', async ({ page }) => {
    active = await installDealMock(page);
    const metrics = await measurePageLoad(page, `${pipelineUrl()}/deals/${X_FULL.id}`, 'low-bandwidth');
    await expect(screen(page)).toBeVisible();
    expect(metrics.fcpMs, 'first contentful paint on the PRD 2.13 link').toBeLessThan(5_000);
  });
});
