import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TENANT_A, USER_A_AGENT_1 } from '@kasuwa/db';
import { stack, type StackUrls } from './support/stack';
import { assertWithinByteBudget, measurePageLoad } from './support/metrics';
import { servedBuildId } from './support/critical-path';
import { installAdminMock } from './support/admin-mock';
import { LIVE_ADMIN } from './support/live-fixtures';
import {
  ACCOUNT_FIELDS,
  CLASSIFICATIONS,
  CONTACT_FIELDS,
  CURRENCIES,
  DEAL_FIELDS,
  DEAL_PICKLIST_API_NAME,
  HOSTILE_LABEL,
  LIMITS,
  OBJECTS,
  REFUSED_TYPES,
  RETIRED_CONTACT,
  TYPES,
  answerProblems,
  errorExamples,
  installCustomFieldsMock,
  isListRead,
  isWrite,
  servedData,
  wellFormedValue,
  type CustomFieldObject,
  type CustomFieldsMock,
  type CustomFieldsMockOptions,
  type Forced,
} from './support/custom-fields-mock';

/**
 * T-0090 — the P18 customisation studio for custom fields
 * (`docs/design/P18/`), behind `crm_custom_fields`, against T-0088's admin
 * contract as served since T-0089 (`listCustomFields`, `createCustomField`,
 * `updateCustomField`, `retireCustomField`). Written by the lead's QA agent
 * BEFORE the screen exists;
 * `tests/acceptance/admin-ui/customisation-studio.acceptance.test.ts` runs
 * this file with `--grep @p18-studio` and reads every outcome by tag.
 * Decisions: ADR-0016, D-L128, D-L138 to D-L143, D-L45, D-L53, D-L84.
 *
 * TAG RULE (D-L84). `@p18-studio` is the parent tag. No other screen's tag
 * may contain it, and it contains no other screen's parent tag. Every sub-tag
 * here is `@p18-studio-<name>`.
 *
 * ---------------------------------------------------------------------------
 * THE WEB PROCESS
 *
 *   webUrl          — the default server, every flag at its default.
 *                     `/admin/custom-fields` must be a real 404 there, and no
 *                     admin screen there links to it.
 *   webStudioUrl    — NEW, published in the stack file by the builder's change
 *                     to `scripts/run-e2e.mjs`. `crm_custom_fields` RIDES ON
 *                     THE RECORDS PROCESS (`webRecordsUrl`): it is the one
 *                     production build with flags on (a dev bundle is not a
 *                     budget, D-L28), and it serves the admin console too.
 *
 * THE STUDIO IS READ FROM THE BROWSER, AND MOCKED THERE — EXCEPT ONCE
 *
 * Every journey but `@p18-studio-live` installs `support/custom-fields-mock.ts`,
 * which serves the four operations (and the admin shell's two reads) from the
 * contract and checks every request and every answer. `afterEach` fails a test
 * in which the screen sent the API anything the contract or this screen's
 * rules (the mock's header) do not allow, left the origin, or in which the
 * mock answered something its own contract rejects. `@p18-studio-live` drives
 * the real API and the seeded database through the same process, with the
 * seed's tenant administrator and an agent, and no interception at all.
 *
 * THE DOM HOOKS THIS FILE RELIES ON (the builder's side of the contract)
 *
 *   [data-testid="settings-menu"]          the admin shell's menu (P02/A1);
 *     [data-setting-id="cu-fields"]        its "Fields" entry: a link to
 *                                          /admin/custom-fields only where the
 *                                          flag is on (aria-current="page" on
 *                                          the studio); a non-link elsewhere
 *   [data-screen="P18/B"]                  the studio root, inside the shell
 *     [data-object-tab="<object>"]         one control per standard object,
 *                                          exactly contact, account, activity,
 *                                          deal; the shown one carries
 *                                          aria-current, aria-selected or
 *                                          aria-pressed = "true"; contact first
 *     [data-testid="field-limit"]          the active count and the limit, as
 *                                          numbers, from the list's `limits`
 *     [data-testid="show-retired"]         a checkbox or switch: retired fields
 *                                          are listed only while it is on
 *     [data-field-row="<apiName>"]         one row per field, in the served
 *       data-type="<type>"                 order, carrying its type,
 *       data-classification="<level>"      classification and whether it is
 *       data-retired="true|false"          retired; it draws the label, the api
 *                                          name, a translated type label, and a
 *                                          translated pii or sensitive label
 *       [data-testid="field-edit"]         opens the edit form (live rows only)
 *       [data-testid="field-retire"]       opens the confirmation (live only)
 *     [data-testid="fields-empty"]         an object with no field to show
 *     [data-testid="field-new"]            opens the create form
 *   [data-testid="field-form"]             a <form>, data-mode="create"|"edit":
 *     [name="label"]                       an input, maxlength 255
 *     input[name="apiName"]                the WHOLE api name, `__c` included,
 *                                          holding exactly what was typed (a
 *                                          suggestion from the label is written
 *                                          only until the admin types here);
 *                                          editable on create only (maxlength
 *                                          63); on edit shown, never editable
 *     [name="type"]                        a <select> or a radio group: the six
 *                                          types, on create only
 *     [name="classification"]              a <select> or a radio group: none,
 *                                          pii, sensitive; default none
 *     [name="description"]                 on edit at least
 *     [name="currencyCode"]                a <select> or a radio group: NGN,
 *                                          GHS, KES, ZAR; create only
 *     [data-testid="picklist-row"]         one per value; an existing value's
 *       data-value="<value>"               row carries its value and holds no
 *       input[data-part="label"]           button (values are never removed);
 *       input[data-part="value"]           the value input is optional
 *     [data-testid="picklist-add"]         adds a value row
 *     [data-testid="classification-default-note"]  pii or sensitive chosen on
 *                                          create: other sets start at no access
 *     [data-testid="classification-warning"]       the classification RAISED on
 *                                          edit: existing access is unchanged
 *     [data-testid="field-save"]           submit; [data-testid="field-cancel"]
 *   [data-testid="retire-dialog"]          role dialog or alertdialog,
 *                                          aria-modal, labelled, naming the
 *     [data-testid="retire-confirm"]       field; confirm and cancel
 *     [data-testid="retire-cancel"]
 *   [data-record-text]                     tenant data (labels, api names,
 *                                          descriptions), not UI copy (en-XA)
 *
 * PINNED INTERFACES BEYOND THE HOOKS (the suite's rulings R1–R25)
 *
 *   - Only what the admin changed is sent on edit; type, api name and the
 *     currency never; picklist values are added or relabelled, never removed.
 *   - Nothing the studio can know is refused is ever sent (the mock's list).
 *   - A successful save closes the form; a double click sends one write.
 *   - Every error the four operations can answer is drawn localised, never
 *     the raw code or the contract's English `message`; a custom-field detail
 *     code is drawn by its own label; the draft survives.
 *   - Write controls show to every caller and the API's 403 is the gate
 *     (D-L84): no capability read exists yet (T-0079).
 *
 * DESIGN AGAINST CONTRACT — WHERE THEY DISAGREE THE CONTRACT WINS
 *
 *   Absent: custom objects, relationships, page layouts, validation rules and
 *   record types (T-0090 non-goals); delete and its 15-day restore (retire,
 *   no restore); changing a type, and an api name editable after create;
 *   "Used in" counts and "unused fields" (no usage data exists); plan meters
 *   and "Compare plans" (the limits are the contract's); currencies beyond
 *   NGN, GHS, KES and ZAR, and "Programme's currency"; text length, number
 *   decimals and range, default values, help-text translations, "required
 *   on this layout", encrypted ID fields and the filterable meter; removing a
 *   picklist value.
 * ---------------------------------------------------------------------------
 */

const STUDIO_ROUTE = '/admin/custom-fields';
const SCREEN = '[data-screen="P18/B"]';
const FORM = '[data-testid="field-form"]';
const DIALOG = '[data-testid="retire-dialog"]';

/**
 * The /admin/custom-fields transferred-byte budget, pinned by the lead (T-0090,
 * D-L145) from the builder's runs: 259,164 and 259,660 bytes on the final code
 * (259,876 and 260,023 on earlier code). 266,000 passes every run, is within 5%
 * of the lowest, and leaves about 2.4% of headroom. The acceptance suite holds
 * it at or under 270,000 and within 5% of what each run measures.
 */
const STUDIO_BUDGET_BYTES = 274_500;

const EN = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>;

/** The contract example's active contact fields, by api name, written out by hand (the mock test proves they agree). */
const CONTACT_ACTIVE = ['alternate_name__c', 'credit_limit__c', 'renewal_date__c', 'satisfaction_score__c', 'tier__c', 'vip__c'];
const PICKLIST = 'tier__c';
const BOOLEAN = 'vip__c';
const PII_TEXT = 'alternate_name__c';
const CURRENCY_FIELD = 'credit_limit__c';

// ---------------------------------------------------------------------------
// The mock and the clean-up
// ---------------------------------------------------------------------------

let active: CustomFieldsMock | undefined;

test.afterEach(async ({ page }) => {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.mockFaults, 'the MOCK answered something its contract rejects (a mock bug, not the screen’s)').toEqual([]);
    expect(mock.violations, 'the screen sent the API something the contract or this screen’s rules do not allow').toEqual([]);
    const origin = new URL(studioUrl()).origin;
    for (const url of mock.requests) {
      expect(url.origin, 'the studio must call the API same-origin, by a relative path').toBe(origin);
    }
  }
});

function studioUrl(): string {
  const urls = stack() as StackUrls & { webStudioUrl?: string };
  if (typeof urls.webStudioUrl !== 'string' || urls.webStudioUrl === '') {
    throw new Error(
      'the stack file has no webStudioUrl: scripts/run-e2e.mjs starts no web process with crm_custom_fields on ' +
        '(see the header of p18-studio.spec.ts)',
    );
  }
  return urls.webStudioUrl;
}

// ---------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------

function shown(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

function screenOf(page: Page): Locator {
  return page.locator(SCREEN);
}

function formOf(page: Page): Locator {
  return shown(page.locator(FORM)).first();
}

function row(page: Page, apiName: string): Locator {
  return shown(page.locator(`${SCREEN} [data-field-row="${apiName}"]`)).first();
}

async function rowNames(page: Page): Promise<string[]> {
  return shown(page.locator(`${SCREEN} [data-field-row]`)).evaluateAll((rows) => rows.map((element) => element.getAttribute('data-field-row') ?? ''));
}

async function visibleText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"], script, style').forEach((hidden) => hidden.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/** Visible text plus the values of the form controls in it (an api name may be shown in a read-only input). */
async function textAndValues(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"], script, style').forEach((hidden) => hidden.remove());
    const values = Array.from(element.querySelectorAll('input, select, textarea')).map((control) => (control as HTMLInputElement).value);
    return `${(copy.textContent ?? '').replace(/\s+/g, ' ')} ${values.join(' ')}`;
  });
}

/** en.json labels whose id is about the studio (`custom` or `studio`) and ends with one of `suffixes`. */
function studioLabels(...suffixes: string[]): string[] {
  return Object.entries(EN)
    .filter(([id]) => /custom|studio/i.test(id) && suffixes.some((suffix) => id.endsWith(suffix)))
    .map(([, text]) => text);
}

/** The label a classification is drawn with: any id ending `.class.<level>` or `.classification.<level>`. */
function classificationLabels(level: string): string[] {
  return Object.entries(EN)
    .filter(([id]) => id.endsWith(`.class.${level}`) || id.endsWith(`.classification.${level}`))
    .map(([, text]) => text);
}

/** What an error must be drawn as: a custom-field detail's own label when it carries one, else `admin.error.<code>`. */
function errorLabels(body: { code?: unknown; details?: unknown }): string[] {
  const detail = Array.isArray(body.details) ? (body.details[0] as { code?: unknown } | undefined)?.code : undefined;
  if (typeof detail === 'string') return studioLabels(`.${detail}`);
  const top = EN[`admin.error.${String(body.code)}`];
  return top === undefined ? [] : [top];
}

async function expectSaysOneOf(locator: Locator, labels: readonly string[], what: string): Promise<void> {
  expect(labels.length, `en.json has no label for ${what}`).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const said = (await locator.evaluateAll((elements) => elements.map((element) => element.textContent ?? '').join(' '))).replace(/\s+/g, ' ');
      return labels.some((label) => said.includes(label)) ? 'says it' : said.slice(0, 400);
    }, { message: `${what} says none of ${labels.map((label) => `"${label}"`).join(', ')}` })
    .toBe('says it');
}

/** The places an error may be drawn: the form, an alert, a status region, or the dialog. */
function messages(page: Page): Locator {
  return shown(page.locator(`${FORM}, [role="alert"], [role="status"], ${DIALOG}`));
}

function isActive(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) =>
    ['aria-current', 'aria-selected', 'aria-pressed'].some((name) => {
      const value = element.getAttribute(name);
      return value !== null && value !== 'false';
    }),
  );
}

async function expectNoSeriousAxe(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const blocking = results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
  expect(blocking.map((violation) => `${violation.id}: ${violation.help}`), `serious or critical accessibility violations on ${label}`).toEqual([]);
  expect(results.passes.length, 'axe checked nothing').toBeGreaterThan(0);
}

/** A few animation frames: lets a click's handler run (and send) before "nothing was sent" is read. */
async function flushTasks(page: Page): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await page.evaluate(() => new Promise<void>((done) => setTimeout(() => requestAnimationFrame(() => done()), 0)));
  }
}

/** The numbers in a text. Thousands separators may be a comma, a full stop or a (narrow) no-break space; a plain space separates numbers. */
function numbersIn(text: string): number[] {
  const separators = '[,.\\u00a0\\u202f]';
  return (text.match(new RegExp(`\\d+(?:${separators}\\d{3})*`, 'gu')) ?? []).map((value) => Number(value.replace(new RegExp(separators, 'gu'), '')));
}

// ---------------------------------------------------------------------------
// Driving the studio
// ---------------------------------------------------------------------------

async function openStudio(page: Page, options: CustomFieldsMockOptions = {}, query = ''): Promise<CustomFieldsMock> {
  // First, so a run with no studio process fails once, here, and not again in afterEach.
  const url = `${studioUrl()}${STUDIO_ROUTE}${query}`;
  const mock = await installCustomFieldsMock(page, options);
  active = mock;
  const read = page.waitForRequest((request) => isListRead(request, 'contact'));
  const response = await page.goto(url);
  expect(response?.status(), `${STUDIO_ROUTE} with crm_custom_fields on`).toBe(200);
  await expect(screenOf(page)).toBeVisible();
  await read;
  await expect(row(page, CONTACT_ACTIVE[0] ?? ''), 'the studio does not open on contact (the contract’s first object)').toBeVisible();
  return mock;
}

/**
 * Shows an object. `read` is false for an object already shown once, which a
 * studio may keep rather than read again.
 */
async function selectObject(page: Page, object: CustomFieldObject, read = true): Promise<void> {
  const tab = shown(page.locator(`${SCREEN} [data-object-tab="${object}"]`)).first();
  const answered = read ? page.waitForResponse((response) => isListRead(response.request(), object)) : undefined;
  await tab.click();
  if (answered !== undefined) await answered;
  await expect.poll(() => isActive(tab), { message: `the ${object} control is not marked as the shown one` }).toBe(true);
}

async function showRetired(page: Page, on: boolean): Promise<void> {
  const toggle = shown(page.locator(`${SCREEN} [data-testid="show-retired"]`)).first();
  await expect(toggle, 'no show-retired control').toBeVisible();
  const checked = async () => (await toggle.getAttribute('aria-checked')) === 'true' || (await toggle.evaluate((element) => (element as HTMLInputElement).checked === true));
  if ((await checked()) !== on) await toggle.click();
  await expect.poll(checked, { message: `show-retired did not turn ${on ? 'on' : 'off'}` }).toBe(on);
}

async function openCreate(page: Page): Promise<Locator> {
  await shown(page.locator(`${SCREEN} [data-testid="field-new"]`)).first().click();
  const form = formOf(page);
  await expect(form, 'field-new opened no form').toBeVisible();
  await expect(form).toHaveAttribute('data-mode', 'create');
  expect(await form.evaluate((element) => element.tagName), 'the field form is not a <form>').toBe('FORM');
  return form;
}

async function openEdit(page: Page, apiName: string): Promise<Locator> {
  await row(page, apiName).getByTestId('field-edit').click();
  const form = formOf(page);
  await expect(form, `field-edit on ${apiName} opened no form`).toBeVisible();
  await expect(form).toHaveAttribute('data-mode', 'edit');
  return form;
}

/** The values a select or radio group named `name` offers. */
async function offered(form: Locator, name: string): Promise<string[]> {
  return form
    .locator(`select[name="${name}"] option, input[type="radio"][name="${name}"]`)
    .evaluateAll((elements) => elements.map((element) => (element as HTMLInputElement | HTMLOptionElement).value).filter((value) => value !== ''));
}

async function chosen(form: Locator, name: string): Promise<string | null> {
  return form.evaluate((element, control) => {
    const select = element.querySelector<HTMLSelectElement>(`select[name="${control}"]`);
    if (select !== null) return select.value === '' ? null : select.value;
    const radio = element.querySelector<HTMLInputElement>(`input[type="radio"][name="${control}"]:checked`);
    return radio?.value ?? null;
  }, name);
}

async function choose(form: Locator, name: string, value: string): Promise<void> {
  const select = form.locator(`select[name="${name}"]`);
  if ((await select.count()) > 0) {
    await select.selectOption(value);
    return;
  }
  const radio = form.locator(`input[type="radio"][name="${name}"][value="${value}"]`);
  expect(await radio.count(), `the form has no select or radio named ${name} offering ${value}`).toBeGreaterThan(0);
  await radio.check({ force: true });
}

/** Enabled controls named `name`: what an admin could still change. */
function editable(form: Locator, name: string): Locator {
  return form.locator(`[name="${name}"]:not([disabled]):not([readonly]):not([type="hidden"])`);
}

/** Fills a label into a new picklist row, adding one when no empty new row is waiting. */
async function addPicklistLabel(form: Locator, label: string): Promise<void> {
  const fresh = form.locator('[data-testid="picklist-row"]:not([data-value]) input[data-part="label"]');
  const blank = await fresh.evaluateAll((inputs) => inputs.map((input, index) => ((input as HTMLInputElement).value === '' ? index : -1)).filter((index) => index >= 0));
  if (blank.length === 0) {
    await form.getByTestId('picklist-add').click();
    await fresh.last().fill(label);
    return;
  }
  await fresh.nth(blank[0] ?? 0).fill(label);
}

async function fillNew(form: Locator, fields: { label: string; apiName: string; type: string }): Promise<void> {
  await form.locator('[name="label"]').fill(fields.label);
  await form.locator('input[name="apiName"]').fill(fields.apiName);
  await choose(form, 'type', fields.type);
}

/** Submits and waits for the write it sends. */
async function save(page: Page, form: Locator): Promise<Request> {
  const sent = page.waitForRequest((request) => isWrite(request));
  await form.getByTestId('field-save').click();
  const request = await sent;
  await request.response();
  return request;
}

function bodyOf(request: Request): Record<string, unknown> {
  return request.postDataJSON() as Record<string, unknown>;
}

/** The aria-describedby text of a control: where its error is announced. */
async function describedText(control: Locator): Promise<string> {
  return control.evaluate((element) =>
    (element.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter((id) => id !== '')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' '),
  );
}

async function focusInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((target) => {
    const focused = document.activeElement;
    return focused !== null && focused.closest(target) !== null;
  }, selector);
}

/** A successful save closes the form (R12). */
async function expectClosed(page: Page, what: string): Promise<void> {
  await expect(shown(page.locator(FORM)), `the form stayed open after ${what}`).toHaveCount(0);
}

// ===========================================================================
// The mock bites (it runs, and passes, before the screen exists)
// ===========================================================================

test('the contract mock refuses what the contract and the studio’s rules refuse, and checks its own answers @p18-studio @p18-studio-mock', async ({ page }) => {
  // A validator only ever seen accepting proves nothing. Drive the mock with
  // fetch() from a page that exists today (sign-in on the default server) and
  // watch every malformed request land in `violations`, one at a time. No
  // `active` mock: the violations are deliberate and counted explicitly.
  const { webUrl } = stack();
  expect([...TYPES]).toEqual(['text', 'number', 'currency', 'date', 'picklist', 'boolean']);
  expect([...OBJECTS]).toEqual(['contact', 'account', 'activity', 'deal']);
  expect([...CLASSIFICATIONS]).toEqual(['none', 'pii', 'sensitive']);
  expect(REFUSED_TYPES.filter((type) => TYPES.includes(type)), 'a refused type is in the Phase 2 list').toEqual([]);

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

  let mock = await installCustomFieldsMock(page);
  await page.goto(`${webUrl}/`);
  let planted = 0;
  const expectViolation = async (path: string, method: string, body: unknown, status: number, what: RegExp, headers?: Record<string, string>) => {
    const before = mock.violations.length;
    const answer = await call(path, method, body, headers);
    expect(answer.status, `${method} ${path}`).toBe(status);
    const added = mock.violations.slice(before);
    expect(added.join('\n'), `${method} ${path} was not recorded`).toMatch(what);
    expect(added, `${method} ${path} was recorded more than once`).toHaveLength(1);
    planted += 1;
    return answer;
  };
  const clean = async (path: string, method = 'GET', body?: unknown) => {
    const before = mock.violations.length;
    const answer = await call(path, method, body);
    expect(mock.violations.slice(before), `${method} ${path} was blamed on the screen`).toEqual([]);
    return answer;
  };
  const list = '/api/v1/admin/custom-fields';
  const idOf = (apiName: string) => CONTACT_FIELDS.find((entry) => entry.apiName === apiName)?.id ?? '';

  // Served as the contract says, and the hand-written order agrees.
  const contact = await clean(`${list}?object=contact`);
  expect(contact.status).toBe(200);
  expect((contact.body.items as { apiName: string }[]).map((entry) => entry.apiName)).toEqual(CONTACT_ACTIVE);
  expect(contact.body.limits).toEqual(LIMITS);
  const withRetired = await clean(`${list}?object=contact&includeRetired=true`);
  expect((withRetired.body.items as { apiName: string }[]).map((entry) => entry.apiName)).toEqual([...CONTACT_ACTIVE, RETIRED_CONTACT.apiName].sort());
  expect(((await clean(`${list}?object=activity`)).body.items as unknown[]).length).toBe(0);
  expect(((await clean(`${list}?object=deal`)).body.items as unknown[]).length).toBe(DEAL_FIELDS.length);
  expect(((await clean(`${list}?object=account`)).body.items as unknown[]).length).toBe(ACCOUNT_FIELDS.length);

  const created = await clean(list, 'POST', { objectApiName: 'contact', apiName: 'sample_new__c', label: 'Sample new', type: 'text' });
  expect(created.status).toBe(201);
  expect(created.body.classification).toBe('none');
  expect(created.body.config).toEqual({});
  // A taken name, live or retired, is the API's answer, not the screen's fault.
  expect((await clean(list, 'POST', { objectApiName: 'contact', apiName: 'sample_new__c', label: 'Again', type: 'text' })).status).toBe(409);
  const retiredName = await clean(list, 'POST', { objectApiName: 'contact', apiName: RETIRED_CONTACT.apiName, label: 'Again', type: 'text' });
  expect(retiredName.status).toBe(409);
  expect(retiredName.body.code).toBe('duplicate_code');
  const picklist = await clean(list, 'POST', { objectApiName: 'deal', apiName: 'sample_band__c', label: 'Band', type: 'picklist', config: { values: [{ value: 'one', label: 'One' }] } });
  expect(picklist.status).toBe(201);
  expect((await clean(list, 'POST', { objectApiName: 'account', apiName: 'sample_cash__c', label: 'Cash', type: 'currency', classification: 'sensitive', config: { currencyCode: 'KES' } })).status).toBe(201);

  // What the studio could have refused before sending.
  await expectViolation(`${list}?object=lead`, 'GET', undefined, 400, /object=lead/);
  await expectViolation(`${list}?object=contact&programmeId=x`, 'GET', undefined, 200, /programmeId/);
  await expectViolation(list, 'POST', { objectApiName: 'contact', apiName: 'Tier', label: 'T', type: 'text' }, 400, /api name/);
  await expectViolation(list, 'POST', { objectApiName: 'contact', apiName: 'tier_c', label: 'T', type: 'text' }, 400, /api name/);
  await expectViolation(list, 'POST', { objectApiName: 'contact', apiName: `${'a'.repeat(61)}__c`, label: 'T', type: 'text' }, 400, /api name/);
  await expectViolation(list, 'POST', { objectApiName: 'contact', apiName: 'notes__c', label: 'T', type: 'textarea' }, 400, /Phase 2 six/);
  await expectViolation(list, 'POST', { objectApiName: 'contact', apiName: 'notes__c', label: 'T', type: 'text', config: {} }, 400, /config/);
  await expectViolation(list, 'POST', { objectApiName: 'contact', apiName: 'band__c', label: 'T', type: 'picklist', config: { values: [] } }, 400, /picklist was sent with 0/);
  await expectViolation(list, 'POST', { objectApiName: 'contact', apiName: 'band__c', label: 'T', type: 'picklist', config: { values: [{ value: 'a1', label: 'A' }, { value: 'a1', label: 'B' }] } }, 400, /repeated value/);
  await expectViolation(list, 'POST', { objectApiName: 'contact', apiName: 'band__c', label: 'T', type: 'picklist', config: { values: [{ value: 'Bad Value', label: 'A' }] } }, 400, /CustomFieldPicklistValue/);
  await expectViolation(list, 'POST', { objectApiName: 'contact', apiName: 'cash__c', label: 'T', type: 'currency', config: { currencyCode: 'USD' } }, 400, /currency outside/);
  await expectViolation(list, 'POST', { objectApiName: 'contact', apiName: 'cash__c', label: 'T', type: 'currency' }, 400, /currencyCode/);
  await expectViolation(list, 'POST', { objectApiName: 'contact', apiName: 'x1__c', label: 'T', type: 'text', programmeId: 'p' }, 400, /closed body/);
  await expectViolation(list, 'POST', { objectApiName: 'contact', apiName: 'x2__c', label: 'T', type: 'text', isRequired: true }, 400, /closed body/);
  await expectViolation(`${list}?object=contact`, 'GET', undefined, 200, /header/, { 'x-kasuwa-programme-id': 'p' });
  const tier = idOf(PICKLIST);
  await expectViolation(`${list}/${tier}`, 'PATCH', { label: 'Customer tier' }, 200, /label was sent unchanged/);
  await expectViolation(`${list}/${tier}`, 'PATCH', { classification: 'none' }, 200, /classification was sent unchanged/);
  await expectViolation(`${list}/${tier}`, 'PATCH', { relabelValues: [{ value: 'gold', label: 'Gold' }] }, 200, /label did not change/);
  await expectViolation(`${list}/${tier}`, 'PATCH', { relabelValues: [{ value: 'bronze', label: 'Bronze' }] }, 400, /does not have/);
  await expectViolation(`${list}/${tier}`, 'PATCH', { type: 'text' }, 400, /closed body/);
  await expectViolation(`${list}/${tier}`, 'PATCH', { apiName: 'other__c' }, 400, /closed body/);
  await expectViolation(`${list}/${tier}`, 'PATCH', {}, 400, /too few properties/);
  await expectViolation(`${list}/${idOf(BOOLEAN)}`, 'PATCH', { addValues: [{ value: 'yes', label: 'Yes' }] }, 400, /not a picklist/);
  await expectViolation(`${list}/${RETIRED_CONTACT.id}`, 'PATCH', { label: 'Back' }, 400, /retired field was edited/);
  await expectViolation(`${list}/11111111-0000-4000-8000-00000000ffff`, 'PATCH', { label: 'X' }, 404, /never served/);
  await expectViolation(`${list}/${idOf(PII_TEXT)}`, 'DELETE', undefined, 404, /not an operation/);
  await expectViolation('/api/v1/admin/field-security/matrix', 'PUT', { changes: [] }, 404, /not an operation/);
  // A duplicate value is the API's answer.
  const duplicate = await clean(`${list}/${tier}`, 'PATCH', { addValues: [{ value: 'gold', label: 'Gold again' }] });
  expect(duplicate.status).toBe(400);
  expect(duplicate.body.details).toEqual([{ path: 'addValues', code: 'duplicate_value' }]);
  const relabelled = await clean(`${list}/${tier}`, 'PATCH', { label: 'Service tier', relabelValues: [{ value: 'gold', label: 'Gold plus' }], addValues: [{ value: 'bronze', label: 'Bronze' }] });
  expect(relabelled.status).toBe(200);
  expect((relabelled.body.config as { values: { value: string }[] }).values.map((entry) => entry.value)).toEqual(['gold', 'silver', 'platinum', 'bronze']);
  const retired = await clean(`${list}/${idOf(BOOLEAN)}/retire`, 'POST');
  expect(retired.status).toBe(200);
  expect(retired.body.retiredAt).not.toBeNull();
  const again = await expectViolation(`${list}/${idOf(BOOLEAN)}/retire`, 'POST', undefined, 200, /already retired/);
  expect(again.body.retiredAt).toBe(retired.body.retiredAt);
  expect(((await clean(`${list}?object=contact`)).body.items as { apiName: string }[]).map((entry) => entry.apiName)).not.toContain(BOOLEAN);
  expect(mock.mockFaults, 'the mock built an answer its contract rejects').toEqual([]);
  expect(planted).toBeGreaterThanOrEqual(25);

  // A member without custom_field.write: 403 before the body is read; the list still answers.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  mock = await installCustomFieldsMock(page, { caller: 'member' });
  expect((await clean(`${list}?object=contact`)).status).toBe(200);
  expect((await clean(list, 'POST', { objectApiName: 'contact', apiName: 'Bad', label: 'T', type: 'textarea' })).status).toBe(403);
  expect((await clean(`${list}/11111111-0000-4000-8000-00000000ffff`, 'PATCH', { label: 'X' })).status).toBe(403);
  expect((await clean(`${list}/${idOf(BOOLEAN)}/retire`, 'POST')).status).toBe(403);

  // The limits, as data.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  mock = await installCustomFieldsMock(page, { atFieldLimit: 'deal', picklistFull: true });
  const full = await clean(`${list}?object=deal`);
  expect((full.body.items as unknown[]).length).toBe(LIMITS.fieldsPerObject);
  const refused = await clean(list, 'POST', { objectApiName: 'deal', apiName: 'one_more__c', label: 'One more', type: 'text' });
  expect(refused.status).toBe(409);
  expect(refused.body.details).toEqual([{ path: 'objectApiName', code: 'field_limit_reached' }]);
  const band = DEAL_FIELDS.find((entry) => entry.apiName === DEAL_PICKLIST_API_NAME)?.id ?? '';
  const tooMany = await clean(`${list}/${band}`, 'PATCH', { addValues: [{ value: 'one_more', label: 'One more' }] });
  expect(tooMany.status).toBe(409);
  expect(tooMany.body.details).toEqual([{ path: 'addValues', code: 'picklist_limit_reached' }]);

  // A forced answer is served whatever was sent, and still checked.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  mock = await installCustomFieldsMock(page, { createAnswers: [{ status: 400, example: 'unknownCurrency' }, 'network'] });
  const forced = await clean(list, 'POST', { objectApiName: 'contact', apiName: 'fine__c', label: 'Fine', type: 'text' });
  expect(forced.body.details).toEqual([{ path: 'config.currencyCode', code: 'unknown_currency' }]);
  const dropped = await page.evaluate(async (target) => {
    try {
      await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectApiName: 'contact', apiName: 'fine__c', label: 'Fine', type: 'text' }) });
      return 'answered';
    } catch {
      return 'dropped';
    }
  }, list);
  expect(dropped).toBe('dropped');
  expect(mock.mockFaults).toEqual([]);

  // The answer checker bites: a usage count, a plan, or an unknown type is a fault.
  const definition = { ...(CONTACT_FIELDS[0] ?? {}) };
  expect(answerProblems('createCustomField', 201, definition)).toEqual([]);
  expect(answerProblems('createCustomField', 201, { ...definition, usedIn: 3 }).join(' ')).toMatch(/usedIn/);
  expect(answerProblems('createCustomField', 201, { ...definition, type: 'textarea' }).join(' ')).toMatch(/type/);
  expect(answerProblems('listCustomFields', 200, { objectApiName: 'contact', limits: { ...LIMITS, plan: 'growth' }, items: [] }).join(' ')).toMatch(/plan/);
  expect(answerProblems('retireCustomField', 204, {}).join(' ')).toMatch(/declares no 204/);

  // The meter's number reader: separators within a number, never across two.
  expect(numbersIn('6 of 100 active fields')).toEqual([6, 100]);
  expect(numbersIn('6 100')).toEqual([6, 100]);
  expect(numbersIn('1,250 of 2.500')).toEqual([1250, 2500]);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// ===========================================================================
// The flag
// ===========================================================================

test.describe('crm_custom_fields gates the studio', () => {
  // The flag-off tests PASS BEFORE THE WORK STARTS: there is no route, and the
  // menu entry is a non-link today. A negative invariant, legitimately vacuous
  // until the screen exists; @p18-studio-flag-on and @p18-studio-shell give
  // the pair meaning.
  test('/admin/custom-fields is a real 404 with every flag at its default, and no admin screen links to it @p18-studio @p18-studio-flag-off', async ({ page }) => {
    const { webUrl } = stack();
    const mock = await installCustomFieldsMock(page);
    const response = await page.goto(`${webUrl}${STUDIO_ROUTE}`);
    expect(response?.status(), `${STUDIO_ROUTE} is reachable with crm_custom_fields off`).toBe(404);
    await expect(page.locator(SCREEN)).toHaveCount(0);
    expect(mock.requests.filter((url) => url.pathname.startsWith('/api/v1/admin/custom-fields')), 'a flag-off page read custom fields').toEqual([]);
    await page.unrouteAll({ behavior: 'ignoreErrors' });

    // The P02 console on the default server, as `p02-admin.spec.ts` drives it.
    await installAdminMock(page);
    for (const path of ['/admin', '/admin/programmes', '/admin/roles', '/admin/field-security', '/admin/audit']) {
      await page.goto(`${webUrl}${path}`);
      const menu = page.getByTestId('settings-menu');
      await expect(menu).toHaveCount(1);
      // Open the Customisation group, or its entry is never rendered and the check below holds by absence.
      const group = page.getByTestId('nav-group-custom');
      await expect(group).toBeVisible();
      if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
      const entry = menu.locator('[data-setting-id="cu-fields"]');
      await expect(entry, `${path}: the Fields entry is not in the menu`).toHaveCount(1);
      expect(await entry.evaluate((element) => element.tagName), `${path}: the Fields entry is a link with the flag off`).not.toBe('A');
      await expect(page.locator('a[href^="/admin/custom-fields"]'), `${path} links to the studio with the flag off`).toHaveCount(0);
    }
  });

  test('/admin/custom-fields cannot be switched on by anything the browser sends @p18-studio @p18-studio-flag-off', async ({ browser }) => {
    const { webUrl } = stack();
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-kasuwa-feature-flags': 'crm_custom_fields', 'x-crm-custom-fields': '1', 'x-kasuwa-tenant-id': TENANT_A },
    });
    await context.addCookies([
      { name: 'crm_custom_fields', value: 'on', url: webUrl },
      { name: 'kasuwa_flags', value: 'crm_custom_fields', url: webUrl },
    ]);
    const page = await context.newPage();
    for (const path of [`${STUDIO_ROUTE}?crm_custom_fields=on&flags=crm_custom_fields`, `${STUDIO_ROUTE}/`, `${STUDIO_ROUTE}?object=deal`, `${STUDIO_ROUTE}?locale=en-XA`]) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} was switched on from the browser`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    await context.close();
  });

  test('/admin/custom-fields renders the P18 studio with crm_custom_fields on @p18-studio @p18-studio-flag-on', async ({ page }) => {
    await openStudio(page);
    await expect(screenOf(page).locator('[data-field-row]').first()).toBeVisible();
  });
});

// ===========================================================================
// The shell
// ===========================================================================

test('the studio sits in the admin shell, whose Fields entry links it where the flag is on, and no link on it is a 404 @p18-studio @p18-studio-shell', async ({ page }) => {
  await openStudio(page);
  const menu = page.getByTestId('settings-menu');
  await expect(menu).toHaveCount(1);
  await expect(menu.locator(SCREEN), 'the studio is drawn inside the menu').toHaveCount(0);
  const entry = menu.locator('[data-setting-id="cu-fields"]').first();
  await expect(entry, 'the Fields entry is not shown expanded on its own page').toBeVisible();
  await expect(entry).toHaveAttribute('href', STUDIO_ROUTE);
  await expect(entry).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-shell="crm"]'), 'the studio is drawn in the CRM shell').toHaveCount(0);

  // T-0149 (T-0130): the language menu's /translations link moved into the account menu, so the page's links are the
  // settings menu's; every group is opened so each of its entries is checked, not only the Customisation group's.
  const closed = menu.locator('[data-testid^="nav-group-"][aria-expanded="false"]');
  while ((await closed.count()) > 0) await closed.first().click();

  const hrefs = [...new Set(await page.locator('a[href^="/"]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? '')))];
  expect(hrefs.length, 'the page links nowhere — not even the settings menu').toBeGreaterThan(2);
  for (const href of hrefs) {
    const response = await page.request.get(`${studioUrl()}${href}`);
    expect(response.status(), `the page links to ${href}, which is a 404`).not.toBe(404);
  }

  // The same entry, from the console's home on the same process.
  await page.goto(`${studioUrl()}/admin`);
  const groupToggle = page.getByTestId('nav-group-custom');
  if ((await groupToggle.getAttribute('aria-expanded')) !== 'true') await groupToggle.click();
  await expect(page.getByTestId('settings-menu').locator(`a[data-setting-id="cu-fields"][href="${STUDIO_ROUTE}"]`), '/admin does not link the studio').toBeVisible();
});

// ===========================================================================
// The list
// ===========================================================================

test('one control per standard object, exactly the four; each lists only its own fields, and an empty object says so @p18-studio @p18-studio-objects', async ({ page }) => {
  const mock = await openStudio(page);
  const tabs = await shown(page.locator(`${SCREEN} [data-object-tab]`)).evaluateAll((elements) => elements.map((element) => element.getAttribute('data-object-tab') ?? ''));
  expect(tabs, 'the object controls are not exactly the contract’s four, in its order').toEqual([...OBJECTS]);
  expect(await isActive(shown(page.locator(`${SCREEN} [data-object-tab="contact"]`)).first()), 'contact is not shown first').toBe(true);
  for (const object of OBJECTS) {
    await expectSaysOneOf(shown(page.locator(`${SCREEN} [data-object-tab="${object}"]`)), studioLabels(`.object.${object}`), `the ${object} control`);
  }
  await selectObject(page, 'deal');
  await expect.poll(() => rowNames(page)).toEqual(DEAL_FIELDS.map((entry) => entry.apiName).sort());
  await selectObject(page, 'account');
  await expect.poll(() => rowNames(page)).toEqual(ACCOUNT_FIELDS.map((entry) => entry.apiName).sort());
  await selectObject(page, 'activity');
  await expect(shown(page.locator(`${SCREEN} [data-testid="fields-empty"]`)), 'activity has no fields and draws no empty state').toBeVisible();
  expect(await rowNames(page)).toEqual([]);
  await selectObject(page, 'contact', false);
  await expect.poll(() => rowNames(page)).toEqual(CONTACT_ACTIVE);
  for (const url of mock.listReads) {
    expect(url.searchParams.get('object'), 'a list read without an object').not.toBeNull();
  }
});

test('the list shows each active field’s label, api name, type and classification in the served order; markup is text @p18-studio @p18-studio-list', async ({ page }) => {
  await openStudio(page);
  expect(await rowNames(page), 'not the active fields in the served (api name) order').toEqual(CONTACT_ACTIVE);
  await expect(row(page, RETIRED_CONTACT.apiName), 'a retired field is listed by default').toHaveCount(0);
  for (const apiName of CONTACT_ACTIVE) {
    const stored = CONTACT_FIELDS.find((entry) => entry.apiName === apiName);
    const line = row(page, apiName);
    await expect(line).toHaveAttribute('data-type', stored?.type ?? '');
    await expect(line).toHaveAttribute('data-classification', stored?.classification ?? '');
    await expect(line).toHaveAttribute('data-retired', 'false');
    const text = await visibleText(line);
    expect(text, `${apiName}: the label is not drawn`).toContain(stored?.label ?? '<label>');
    expect(text, `${apiName}: the api name is not drawn`).toContain(apiName);
    expect(studioLabels(`.type.${stored?.type ?? ''}`).some((label) => text.includes(label)), `${apiName}: the type is not drawn by its translated label`).toBe(true);
    if (stored?.classification !== 'none') {
      expect(classificationLabels(stored?.classification ?? '').some((label) => text.includes(label)), `${apiName}: the ${stored?.classification} classification is not drawn`).toBe(true);
    }
  }

  await selectObject(page, 'deal');
  const markup = row(page, 'markup_note__c');
  expect(await visibleText(markup), 'a label with markup is not drawn as text').toContain(HOSTILE_LABEL.replace(/\s+/g, ' '));
  expect(await page.evaluate(() => (window as unknown as { __kasuwaXss?: number }).__kasuwaXss), 'a label’s markup was parsed').toBeUndefined();
  await expect(markup.locator('img, b')).toHaveCount(0);
});

test('retired fields are listed only on request, marked retired, read-only @p18-studio @p18-studio-retired', async ({ page }) => {
  await openStudio(page);
  await showRetired(page, true);
  const retired = row(page, RETIRED_CONTACT.apiName);
  await expect(retired, 'the retired field is not listed when asked for').toBeVisible();
  await expect(retired).toHaveAttribute('data-retired', 'true');
  await expectSaysOneOf(retired, studioLabels('.retired'), 'the retired row');
  await expect(retired.getByTestId('field-edit'), 'a retired field can be edited').toHaveCount(0);
  await expect(retired.getByTestId('field-retire'), 'a retired field can be retired again').toHaveCount(0);
  await expect(retired.locator('input:not([disabled]):not([readonly]), select:not([disabled])'), 'a retired row holds an editable control').toHaveCount(0);
  expect(await rowNames(page), 'the active fields went missing when retired ones were added').toEqual(expect.arrayContaining(CONTACT_ACTIVE));
  await showRetired(page, false);
  await expect(row(page, RETIRED_CONTACT.apiName), 'the retired field stays listed after the toggle is off').toHaveCount(0);
});

test('the active count and the contract’s limits are shown and enforced @p18-studio @p18-studio-limits', async ({ page }) => {
  const mock = await openStudio(page, { atFieldLimit: 'deal', picklistFull: true });
  const meter = shown(page.locator(`${SCREEN} [data-testid="field-limit"]`)).first();
  await expect(meter).toBeVisible();
  await expect.poll(async () => numbersIn(await visibleText(meter)), { message: 'the meter does not show the active count and the limit' }).toEqual(
    expect.arrayContaining([CONTACT_ACTIVE.length, LIMITS.fieldsPerObject]),
  );
  const form = await openCreate(page);
  await expect(form.locator('[name="label"]')).toHaveAttribute('maxlength', String(255));
  await expect(form.locator('input[name="apiName"]')).toHaveAttribute('maxlength', String(63));
  await form.getByTestId('field-cancel').click();

  // A full object: either no create is offered and the limit is said, or a create is refused and drawn.
  await selectObject(page, 'deal');
  await expect.poll(async () => numbersIn(await visibleText(meter))).toEqual(expect.arrayContaining([LIMITS.fieldsPerObject]));
  const create = shown(page.locator(`${SCREEN} [data-testid="field-new"]`)).first();
  const limitLabels = studioLabels('.field_limit_reached');
  if ((await create.count()) === 0 || (await create.isDisabled())) {
    await expectSaysOneOf(shown(page.locator(SCREEN)), limitLabels, 'a full object');
  } else {
    const full = await openCreate(page);
    await fillNew(full, { label: 'Sample one more', apiName: 'sample_one_more__c', type: 'text' });
    const request = await save(page, full);
    expect((await request.response())?.status()).toBe(409);
    await expectSaysOneOf(messages(page), limitLabels, 'a create refused at the limit');
    await full.getByTestId('field-cancel').click();
  }
  expect(mock.store.deal.filter((entry) => entry.retiredAt === null).length, 'a field was created past the limit').toBe(LIMITS.fieldsPerObject);

  // A full picklist: the same, for a value.
  const band = await openEdit(page, DEAL_PICKLIST_API_NAME);
  const add = band.getByTestId('picklist-add');
  const picklistLabels = studioLabels('.picklist_limit_reached');
  if ((await add.count()) === 0 || (await add.isDisabled())) {
    await expectSaysOneOf(band, picklistLabels, 'a full picklist');
  } else {
    await addPicklistLabel(band, 'Sample band extra');
    const request = await save(page, band);
    expect((await request.response())?.status()).toBe(409);
    await expectSaysOneOf(messages(page), picklistLabels, 'a value refused at the limit');
  }
  const stored = mock.store.deal.find((entry) => entry.apiName === DEAL_PICKLIST_API_NAME);
  expect((stored?.config.values as unknown[]).length, 'a value was added past the limit').toBe(LIMITS.picklistValues);
});

// ===========================================================================
// Create
// ===========================================================================

test('a text field is created with exactly what the admin typed, appears in the list, and a double click sends one create @p18-studio @p18-studio-create', async ({ page }) => {
  const mock = await openStudio(page, { holdWrites: true });
  const form = await openCreate(page);
  expect(await chosen(form, 'classification'), 'the classification does not default to none').toBe('none');
  await form.locator('[name="label"]').fill('Sample renewal owner');
  // The studio may suggest the api name from the label; a suggestion must already obey the rule.
  const suggested = await form.locator('input[name="apiName"]').inputValue();
  if (suggested !== '') expect(suggested, 'the suggested api name breaks the __c rule').toMatch(/^[a-z][a-z0-9_]*__c$/);
  await form.locator('input[name="apiName"]').fill('renewal_owner__c');
  await choose(form, 'type', 'text');
  const sent = page.waitForRequest((request) => isWrite(request));
  await form.getByTestId('field-save').dblclick();
  const request = await sent;
  await flushTasks(page);
  mock.release();
  await request.response();
  await expectClosed(page, 'a create');
  await expect(row(page, 'renewal_owner__c'), 'the new field is not listed').toBeVisible();
  expect(mock.writes.filter((write) => write.operation === 'createCustomField'), 'a double click sent more than one create').toHaveLength(1);
  const body = bodyOf(request);
  expect(Object.keys(body).filter((key) => !['objectApiName', 'apiName', 'label', 'type', 'classification', 'description'].includes(key)), 'the create carries more than the contract’s fields').toEqual([]);
  expect(body).toMatchObject({ objectApiName: 'contact', apiName: 'renewal_owner__c', label: 'Sample renewal owner', type: 'text' });
  expect(body.classification ?? 'none').toBe('none');
  expect('config' in body, 'a text field was sent a config').toBe(false);
  await expect(row(page, 'renewal_owner__c')).toHaveAttribute('data-type', 'text');
  expect(await visibleText(row(page, 'renewal_owner__c'))).toContain('Sample renewal owner');
});

test('an api name that breaks the __c rule is refused before it is sent, and a taken one is refused by name @p18-studio @p18-studio-api-name', async ({ page }) => {
  const mock = await openStudio(page);
  const form = await openCreate(page);
  await form.locator('[name="label"]').fill('Sample bad name');
  await choose(form, 'type', 'text');
  const apiName = form.locator('input[name="apiName"]');
  for (const bad of ['Tier__c', 'tier', 'tier_c', '9tier__c', 'tier__C', 'ti er__c', '__c']) {
    await apiName.fill(bad);
    await expect(apiName, `the api name input rewrote "${bad}" as it was typed`).toHaveValue(bad);
    await form.getByTestId('field-save').click();
    await flushTasks(page);
    await expect(apiName, `"${bad}" is not marked invalid`).toHaveAttribute('aria-invalid', 'true');
    await expect.poll(() => describedText(apiName), { message: `"${bad}": the error is not announced through aria-describedby` }).not.toBe('');
    await expectSaysOneOf(form, studioLabels('.invalid_api_name'), `the form after "${bad}"`);
  }
  expect(mock.writes, 'a name the studio could refuse was sent').toEqual([]);

  // Taken by a live field, and by a retired one (a retired name stays taken for ever).
  for (const taken of [PICKLIST, RETIRED_CONTACT.apiName]) {
    await apiName.fill(taken);
    await form.getByTestId('field-save').click();
    await expectSaysOneOf(messages(page), studioLabels('.duplicate'), `a create named ${taken}`);
    expect(mock.store.contact.filter((entry) => entry.apiName === taken), `a second ${taken} was created`).toHaveLength(1);
  }
  await expect(form.locator('[name="label"]'), 'the draft was lost after a refusal').toHaveValue('Sample bad name');
  expect(mock.writes.filter((write) => write.status === 201), 'a taken name was created').toEqual([]);
});

test('the type offers exactly the six Phase 2 types; picklist and currency take their config, the rest none @p18-studio @p18-studio-types', async ({ page }) => {
  const mock = await openStudio(page);
  let form = await openCreate(page);
  expect((await offered(form, 'type')).sort(), 'the type control does not offer exactly the six Phase 2 types').toEqual([...TYPES].sort());
  for (const type of TYPES) {
    expect(studioLabels(`.type.${type}`).length, `no translated label for ${type}`).toBeGreaterThan(0);
  }
  const typeText = await textAndValues(form);
  for (const refused of ['Long text', 'Formula', 'Lookup', 'Roll-up', 'Multi-select', 'Date and time', 'Phone', 'Email', 'URL', 'Auto-number', 'File', 'ID number']) {
    expect(typeText, `a refused type is offered (${refused})`).not.toContain(refused);
  }

  // A picklist: values from labels, each value well formed and unique.
  await fillNew(form, { label: 'Sample service band', apiName: 'service_band__c', type: 'picklist' });
  await form.getByTestId('field-save').click();
  await flushTasks(page);
  expect(mock.writes, 'a picklist with no values was sent').toEqual([]);
  await addPicklistLabel(form, 'Gold plus');
  await addPicklistLabel(form, 'Silver');
  let request = await save(page, form);
  const values = (bodyOf(request).config as { values?: { value: string; label: string }[] } | undefined)?.values ?? [];
  expect(values.map((entry) => entry.label)).toEqual(['Gold plus', 'Silver']);
  expect(values.every((entry) => wellFormedValue(entry.value)), 'a picklist value breaks the contract’s pattern').toBe(true);
  expect(new Set(values.map((entry) => entry.value)).size).toBe(2);
  await expectClosed(page, 'creating a picklist');
  await expect(row(page, 'service_band__c')).toBeVisible();

  // A currency: exactly the four codes, and one is required.
  form = await openCreate(page);
  await fillNew(form, { label: 'Sample deposit', apiName: 'deposit__c', type: 'currency' });
  expect((await offered(form, 'currencyCode')).sort(), 'the currency control does not offer exactly NGN, GHS, KES and ZAR').toEqual([...CURRENCIES].sort());
  if ((await chosen(form, 'currencyCode')) === null) {
    await form.getByTestId('field-save').click();
    await flushTasks(page);
    expect(mock.writes.filter((write) => write.operation === 'createCustomField'), 'a currency field without a code was sent').toHaveLength(1);
  }
  await choose(form, 'currencyCode', 'KES');
  request = await save(page, form);
  expect(bodyOf(request).config).toEqual({ currencyCode: 'KES' });
  await expectClosed(page, 'creating a currency field');

  // Number, date and boolean take no config.
  for (const type of ['number', 'date', 'boolean']) {
    form = await openCreate(page);
    await fillNew(form, { label: `Sample ${type}`, apiName: `sample_${type}__c`, type });
    request = await save(page, form);
    expect('config' in bodyOf(request), `a ${type} field was sent a config`).toBe(false);
    await expectClosed(page, `creating a ${type} field`);
    await expect(row(page, `sample_${type}__c`)).toHaveAttribute('data-type', type);
  }
});

test('the classification is offered as none, pii or sensitive; pii and sensitive say other sets start with no access @p18-studio @p18-studio-classification', async ({ page }) => {
  await openStudio(page);
  const form = await openCreate(page);
  expect((await offered(form, 'classification')).sort()).toEqual([...CLASSIFICATIONS].sort());
  const note = shown(form.locator('[data-testid="classification-default-note"]'));
  await expect(note, 'a none field shows the default-access note').toHaveCount(0);
  for (const level of ['pii', 'sensitive']) {
    await choose(form, 'classification', level);
    await expect(note.first(), `${level} chosen and no note that other sets start at no access`).toBeVisible();
    await expectSaysOneOf(note, studioLabels('.classification_default', '.classificationDefault'), `the ${level} note`);
  }
  await choose(form, 'classification', 'none');
  await expect(note).toHaveCount(0);
  await choose(form, 'classification', 'pii');
  await fillNew(form, { label: 'Sample home address', apiName: 'home_address__c', type: 'text' });
  const request = await save(page, form);
  expect(bodyOf(request).classification).toBe('pii');
  await expectClosed(page, 'creating a pii field');
  await expect(row(page, 'home_address__c')).toHaveAttribute('data-classification', 'pii');
});

// ===========================================================================
// Edit
// ===========================================================================

test('edit relabels, describes and adds or relabels picklist values, sending only what changed; type, api name and currency are locked @p18-studio @p18-studio-edit', async ({ page }) => {
  const mock = await openStudio(page);
  let form = await openEdit(page, PICKLIST);
  await expect(editable(form, 'type'), 'the type can be changed after create').toHaveCount(0);
  await expect(editable(form, 'apiName'), 'the api name can be changed after create').toHaveCount(0);
  const shownText = await textAndValues(form);
  expect(shownText, 'the edit form does not show the api name').toContain(PICKLIST);
  expect(studioLabels('.type.picklist').some((label) => shownText.includes(label)), 'the edit form does not show the type').toBe(true);
  const existing = form.locator('[data-testid="picklist-row"][data-value]');
  await expect(existing).toHaveCount(3);
  await expect(existing.locator('button'), 'an existing picklist value can be removed or reordered').toHaveCount(0);

  await form.locator('[name="label"]').fill('Sample service tier');
  let request = await save(page, form);
  expect(bodyOf(request), 'a relabel sent more than the label').toEqual({ label: 'Sample service tier' });
  await expectClosed(page, 'a relabel');
  await expect.poll(async () => visibleText(row(page, PICKLIST))).toContain('Sample service tier');

  form = await openEdit(page, PICKLIST);
  await form.locator('[name="description"]').fill('A synthetic description.');
  request = await save(page, form);
  expect(bodyOf(request)).toEqual({ description: 'A synthetic description.' });
  await expectClosed(page, 'a new description');

  form = await openEdit(page, PICKLIST);
  await form.locator('[data-testid="picklist-row"][data-value="gold"] input[data-part="label"]').fill('Gold plus');
  request = await save(page, form);
  expect(bodyOf(request)).toEqual({ relabelValues: [{ value: 'gold', label: 'Gold plus' }] });
  await expectClosed(page, 'a value relabel');

  form = await openEdit(page, PICKLIST);
  await addPicklistLabel(form, 'Bronze');
  request = await save(page, form);
  await expectClosed(page, 'an added value');
  const added = bodyOf(request);
  expect(Object.keys(added)).toEqual(['addValues']);
  const [value] = added.addValues as { value: string; label: string }[];
  expect(value?.label).toBe('Bronze');
  expect(wellFormedValue(value?.value ?? ''), 'the added value breaks the contract’s pattern').toBe(true);
  const tier = mock.store.contact.find((entry) => entry.apiName === PICKLIST);
  expect((tier?.config.values as { value: string }[]).map((entry) => entry.value).slice(0, 3)).toEqual(['gold', 'silver', 'platinum']);

  // A currency field's code is fixed for its life (D-L128 Q6).
  await selectObject(page, 'account');
  form = await openEdit(page, CURRENCY_FIELD);
  await expect(editable(form, 'currencyCode'), 'the currency can be changed after create').toHaveCount(0);
  expect(await textAndValues(form), 'the edit form does not show the currency').toContain('NGN');
  await form.getByTestId('field-cancel').click();
  expect(mock.writes.filter((write) => write.fieldId !== undefined && write.status !== 200), 'an edit was refused').toEqual([]);
});

test('raising a classification warns that existing access is unchanged; the change is saved alone @p18-studio @p18-studio-raise-warning', async ({ page }) => {
  await openStudio(page);
  const form = await openEdit(page, PICKLIST);
  const warning = shown(form.locator('[data-testid="classification-warning"]'));
  await expect(warning, 'a warning with nothing changed').toHaveCount(0);
  await choose(form, 'classification', 'pii');
  await expect(warning.first(), 'none to pii raised the classification without a warning').toBeVisible();
  await expectSaysOneOf(warning, studioLabels('.classification_raised', '.classificationRaised'), 'the raise warning');
  await choose(form, 'classification', 'none');
  await expect(warning, 'the warning stays after the change is undone').toHaveCount(0);
  await choose(form, 'classification', 'sensitive');
  await expect(warning.first()).toBeVisible();
  const request = await save(page, form);
  expect(bodyOf(request)).toEqual({ classification: 'sensitive' });
  await expectClosed(page, 'a reclassification');
  await expect(row(page, PICKLIST)).toHaveAttribute('data-classification', 'sensitive');

  const pii = await openEdit(page, PII_TEXT);
  await choose(pii, 'classification', 'sensitive');
  await expect(shown(pii.locator('[data-testid="classification-warning"]')).first(), 'pii to sensitive raised it without a warning').toBeVisible();
});

// ===========================================================================
// Retire
// ===========================================================================

test('retire asks first in a labelled modal dialog; cancel sends nothing; confirm retires, and the field shows retired, read-only @p18-studio @p18-studio-retire', async ({ page }) => {
  const mock = await openStudio(page);
  const opener = row(page, BOOLEAN).getByTestId('field-retire');
  await opener.click();
  const dialog = shown(page.locator(DIALOG)).first();
  await expect(dialog).toBeVisible();
  expect(['dialog', 'alertdialog']).toContain(await dialog.getAttribute('role'));
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  const named = await dialog.evaluate((element) => {
    const by = element.getAttribute('aria-labelledby');
    return (element.getAttribute('aria-label') ?? '') + (by === null ? '' : document.getElementById(by)?.textContent ?? '');
  });
  expect(named.trim(), 'the dialog has no accessible name').not.toBe('');
  expect(await visibleText(dialog), 'the dialog does not name the field').toContain('Priority customer');
  await expect.poll(() => focusInside(page, DIALOG), { message: 'focus did not move into the dialog' }).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(opener, 'focus did not return to the retire control').toBeFocused();
  await opener.click();
  await shown(page.locator(DIALOG)).first().getByTestId('retire-cancel').click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await flushTasks(page);
  expect(mock.writes, 'cancelling the dialog retired something').toEqual([]);

  await opener.click();
  const sent = page.waitForRequest((request) => isWrite(request));
  await shown(page.locator(DIALOG)).first().getByTestId('retire-confirm').click();
  const request = await sent;
  await request.response();
  expect(new URL(request.url()).pathname).toMatch(/\/retire$/);
  expect(request.method()).toBe('POST');
  await expect(row(page, BOOLEAN), 'the retired field is still listed as active').toHaveCount(0);
  await showRetired(page, true);
  const retired = row(page, BOOLEAN);
  await expect(retired).toHaveAttribute('data-retired', 'true');
  await expect(retired.getByTestId('field-edit')).toHaveCount(0);
  await expect(retired.getByTestId('field-retire')).toHaveCount(0);
  expect(mock.writes.filter((write) => write.operation === 'retireCustomField')).toHaveLength(1);
});

// ===========================================================================
// Errors and who may write
// ===========================================================================

interface Case {
  readonly name: string;
  readonly forced: Forced;
  /** The answer's body, or null for a dropped connection. */
  readonly body: Record<string, unknown> | null;
}

/**
 * The cases in the order they are served: the ones after which a studio may
 * reasonably close the form or stop offering the action (`fieldLimit`,
 * `fieldRetired`, a `404`) come last, after the dropped connection.
 */
function cases(entries: [number, string, Record<string, unknown>][], last: readonly string[]): Case[] {
  const toCase = ([status, name, body]: [number, string, Record<string, unknown>]): Case => ({ name: `${status} ${name}`, forced: { status, example: name }, body });
  const isLast = ([status, name]: [number, string, unknown]) => last.includes(name) || status === 404;
  return [
    ...entries.filter((entry) => !isLast(entry)).map(toCase),
    { name: 'a dropped connection', forced: 'network', body: null },
    ...entries.filter(isLast).map(toCase),
  ];
}

/** After these the form may close (the field is gone or retired); after every other refusal it stays, with the draft. */
const MAY_CLOSE = /404|fieldRetired/;

test('every error the create, update and retire can answer is drawn localised, never as a code or the English message; the draft survives @p18-studio @p18-studio-errors', async ({ page }) => {
  const createErrors = errorExamples('createCustomField');
  const updateErrors = errorExamples('updateCustomField').filter(([status, name]) => status !== 400 || ['notAPicklist', 'unknownValue', 'duplicateAddedValue', 'fieldRetired'].includes(name));
  const retireErrors = errorExamples('retireCustomField');
  const createCases = cases(createErrors, ['fieldLimit']);
  const updateCases = cases(updateErrors, ['fieldRetired']);
  const retireCases = cases(retireErrors, []);
  const mock = await openStudio(page, {
    createAnswers: createCases.map((entry) => entry.forced),
    updateAnswers: updateCases.map((entry) => entry.forced),
    retireAnswers: retireCases.map((entry) => entry.forced),
  });
  const labels = new Set(Object.values(EN));
  const contractMessages = [...createErrors, ...updateErrors, ...retireErrors].map(([, , body]) => String(body.message)).filter((message) => !labels.has(message));
  expect(contractMessages.length, 'every contract message is also a catalogue label: the English-message check proves nothing').toBeGreaterThan(0);

  const expectDrawn = async (body: Record<string, unknown> | null, what: string) => {
    const wanted = body === null ? [EN['admin.error.network'] ?? '<admin.error.network>'] : errorLabels(body);
    await expectSaysOneOf(messages(page), wanted, what);
    const said = (await messages(page).allTextContents()).join(' ');
    const codes = body === null ? [] : [String(body.code), ...((body.details ?? []) as { code: string }[]).map((detail) => detail.code)];
    for (const code of codes) expect(said, `${what}: the raw code ${code} is drawn`).not.toContain(code);
    for (const message of contractMessages) expect(said, `${what}: the contract’s English message is drawn`).not.toContain(message);
  };

  for (const [index, entry] of createCases.entries()) {
    const form = (await shown(page.locator(FORM)).count()) > 0 ? formOf(page) : await openCreate(page);
    await form.locator('[name="label"]').fill(`Sample error ${index}`);
    await form.locator('input[name="apiName"]').fill(`sample_error_${index}__c`);
    await choose(form, 'type', 'text');
    await save(page, form);
    await expectDrawn(entry.body, `create answered ${entry.name}`);
    if (!MAY_CLOSE.test(entry.name)) await expect(form.locator('[name="label"]'), `the draft was lost after ${entry.name}`).toHaveValue(`Sample error ${index}`);
  }
  if ((await shown(page.locator(FORM)).count()) > 0) await formOf(page).getByTestId('field-cancel').click();
  expect(mock.store.contact.filter((entry) => entry.apiName.startsWith('sample_error_')), 'a refused create was stored').toEqual([]);
  await expect(row(page, 'sample_error_0__c'), 'a refused create was listed').toHaveCount(0);

  for (const [index, entry] of updateCases.entries()) {
    const edit = (await shown(page.locator(FORM)).count()) > 0 ? formOf(page) : await openEdit(page, PICKLIST);
    await edit.locator('[name="label"]').fill(`Sample relabel ${index}`);
    await save(page, edit);
    await expectDrawn(entry.body, `update answered ${entry.name}`);
    if (!MAY_CLOSE.test(entry.name)) await expect(edit.locator('[name="label"]'), `the draft was lost after ${entry.name}`).toHaveValue(`Sample relabel ${index}`);
  }
  if ((await shown(page.locator(FORM)).count()) > 0) await formOf(page).getByTestId('field-cancel').click();
  expect(mock.store.contact.find((entry) => entry.apiName === PICKLIST)?.label, 'a refused update was applied').toBe('Customer tier');

  for (const entry of retireCases) {
    if ((await shown(page.locator(DIALOG)).count()) === 0) await row(page, BOOLEAN).getByTestId('field-retire').click();
    const sent = page.waitForRequest((request) => isWrite(request));
    await shown(page.locator(DIALOG)).first().getByTestId('retire-confirm').click();
    await (await sent).response();
    await expectDrawn(entry.body, `retire answered ${entry.name}`);
  }
  expect(mock.store.contact.find((entry) => entry.apiName === BOOLEAN)?.retiredAt, 'a refused retire was applied').toBeNull();
  expect(mock.writes.filter((write) => write.status >= 200 && write.status < 300), 'a forced refusal was answered with success').toEqual([]);
});

test('a caller without custom_field.write reads the list; every write is refused by the API and drawn, the draft kept (D-L84) @p18-studio @p18-studio-not-permitted', async ({ page }) => {
  const mock = await openStudio(page, { caller: 'member' });
  expect(await rowNames(page), 'the list needs no permission').toEqual(CONTACT_ACTIVE);
  const notPermitted = [EN['admin.error.not_permitted'] ?? '<admin.error.not_permitted>', ...studioLabels('.not_permitted')];

  const form = await openCreate(page);
  await fillNew(form, { label: 'Sample refused', apiName: 'sample_refused__c', type: 'text' });
  await save(page, form);
  await expectSaysOneOf(shown(page.locator('[role="alert"]')), notPermitted, 'the refused create (role="alert")');
  await expect(form.locator('[name="label"]')).toHaveValue('Sample refused');
  await form.getByTestId('field-cancel').click();
  await expect(row(page, 'sample_refused__c')).toHaveCount(0);

  const edit = await openEdit(page, PICKLIST);
  await edit.locator('[name="label"]').fill('Sample refused relabel');
  await save(page, edit);
  await expectSaysOneOf(shown(page.locator('[role="alert"]')), notPermitted, 'the refused edit');
  await expect(edit.locator('[name="label"]')).toHaveValue('Sample refused relabel');
  await edit.getByTestId('field-cancel').click();
  expect(await visibleText(row(page, PICKLIST))).toContain('Customer tier');

  await row(page, BOOLEAN).getByTestId('field-retire').click();
  const sent = page.waitForRequest((request) => isWrite(request));
  await shown(page.locator(DIALOG)).first().getByTestId('retire-confirm').click();
  await (await sent).response();
  await expectSaysOneOf(shown(page.locator('[role="alert"]')), notPermitted, 'the refused retire');
  expect(mock.writes.map((write) => write.status)).toEqual([403, 403, 403]);
});

test.fixme('a caller without custom_field.write is offered no write control (waits on the capability read, T-0079) @p18-studio @p18-studio-writers', async ({ page }) => {
  await openStudio(page, { caller: 'member' });
  await expect(page.locator(`${SCREEN} [data-testid="field-new"], ${SCREEN} [data-testid="field-edit"], ${SCREEN} [data-testid="field-retire"]`)).toHaveCount(0);
});

// ===========================================================================
// Keyboard, screen readers and axe
// ===========================================================================

test('the forms and the dialog work from the keyboard, and errors are announced @p18-studio @p18-studio-keyboard', async ({ page }) => {
  const mock = await openStudio(page);
  const opener = shown(page.locator(`${SCREEN} [data-testid="field-new"]`)).first();
  await opener.focus();
  await page.keyboard.press('Enter');
  const form = formOf(page);
  await expect(form).toBeVisible();
  await expect.poll(() => focusInside(page, FORM), { message: 'opening the form by keyboard did not move focus into it' }).toBe(true);
  const label = form.locator('[name="label"]');
  await label.focus();
  await page.keyboard.type('Sample keyboard field');
  // Empty the api name (a studio may suggest one from the label), so the form is incomplete whatever the type defaults to.
  await form.locator('input[name="apiName"]').fill('');
  await label.focus();
  await page.keyboard.press('Enter');
  await flushTasks(page);
  expect(mock.writes, 'Enter submitted an incomplete form to the API').toEqual([]);
  const invalid = form.locator('[aria-invalid="true"]');
  await expect(invalid.first(), 'Enter in the form marked nothing invalid: it is not a submitting <form>, or it does not validate').toBeVisible();
  for (const control of await invalid.all()) {
    expect(await describedText(control), 'an invalid control’s error is not announced through aria-describedby').not.toBe('');
  }
  await form.locator('input[name="apiName"]').fill('keyboard_field__c');
  await choose(form, 'type', 'boolean');
  await label.focus();
  const sent = page.waitForRequest((request) => isWrite(request));
  await page.keyboard.press('Enter');
  await (await sent).response();
  await expectClosed(page, 'a keyboard create');
  await expect(row(page, 'keyboard_field__c')).toBeVisible();

  // The dialog traps focus and gives it back.
  const retire = row(page, BOOLEAN).getByTestId('field-retire');
  await retire.focus();
  await page.keyboard.press('Enter');
  await expect(shown(page.locator(DIALOG)).first()).toBeVisible();
  await expect.poll(() => focusInside(page, DIALOG), { message: 'focus did not move into the dialog' }).toBe(true);
  for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    expect(await focusInside(page, DIALOG), `${key} left the open dialog`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(retire).toBeFocused();
});

test('the list, both forms, a refusal, the warning and the dialog pass axe @p18-studio @p18-studio-axe', async ({ page }) => {
  await openStudio(page, { createAnswers: [{ status: 409, example: 'duplicate' }] });
  await expectNoSeriousAxe(page, 'the studio list');
  const create = await openCreate(page);
  await fillNew(create, { label: 'Sample axe', apiName: 'sample_axe__c', type: 'picklist' });
  await addPicklistLabel(create, 'One');
  await save(page, create);
  await expectSaysOneOf(messages(page), studioLabels('.duplicate'), 'the refusal');
  await expectNoSeriousAxe(page, 'the create form with a refusal');
  await create.getByTestId('field-cancel').click();
  const edit = await openEdit(page, PICKLIST);
  await choose(edit, 'classification', 'sensitive');
  await expect(shown(edit.locator('[data-testid="classification-warning"]')).first()).toBeVisible();
  await expectNoSeriousAxe(page, 'the edit form with the warning');
  await edit.getByTestId('field-cancel').click();
  await row(page, BOOLEAN).getByTestId('field-retire').click();
  await expect(shown(page.locator(DIALOG)).first()).toBeVisible();
  await expectNoSeriousAxe(page, 'the retire dialog');
});

// ===========================================================================
// The overruled design
// ===========================================================================

test('none of the overruled design: custom objects, layouts, rules, delete or restore, type change, usage, plans, extra currencies @p18-studio @p18-studio-absent', async ({ page }) => {
  await openStudio(page);
  const banned = /\b(delete|restore|undo|used in|not used|unused|growth plan|scale plan|compare plans|upgrade|new object|custom objects?|relationships?|page layouts?|layout builder|validation rules?|record types?|translator|default value|help text|required on|filterable|change type)\b/i;
  // The studio's own surfaces only: its screen, its form and its dialog (lead edit, T-0090, D-L145). The P02
  // menu around it lists the unbuilt Customisation entries ("Page layouts", "Validation rules", "Record types")
  // as aria-disabled, announced to assistive technology; they are the menu's, not the studio's.
  const check = async (where: string) => {
    const parts = await shown(page.locator(`${SCREEN}, ${FORM}, ${DIALOG}`)).all();
    expect(parts.length, `${where}: no studio surface to read`).toBeGreaterThan(0);
    const copy = (await Promise.all(parts.map((part) => visibleText(part)))).join(' ');
    expect(copy.match(banned)?.[0], `${where} draws the overruled design`).toBeUndefined();
  };
  await check('the list');
  await showRetired(page, true);
  await check('the list with retired fields');
  const create = await openCreate(page);
  await choose(create, 'type', 'currency');
  await check('the create form');
  const values = await textAndValues(create);
  for (const currency of ['USD', 'XOF', 'EUR', 'GBP']) expect(values, `${currency} is offered`).not.toContain(currency);
  await create.getByTestId('field-cancel').click();
  const edit = await openEdit(page, PICKLIST);
  await check('the edit form');
  await edit.getByTestId('field-cancel').click();
  await row(page, BOOLEAN).getByTestId('field-retire').click();
  await check('the retire dialog');
});

// ===========================================================================
// Mobile and i18n
// ===========================================================================

test('at 360px the studio and its form fit without sideways page scroll and pass axe @p18-studio @p18-studio-mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openStudio(page);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow(), 'the studio scrolls sideways at 360px').toBeLessThanOrEqual(0);
  await expect(row(page, PICKLIST)).toBeVisible();
  await expectNoSeriousAxe(page, 'P18 at 360px');
  const form = await openCreate(page);
  await choose(form, 'type', 'picklist');
  // T-0149 (T-0142): on a phone the editor is a bottom sheet whose body scrolls, and picking a type card scrolls it
  // down to the card; the label is above. It must still come into view on the screen, not sit off it.
  await form.locator('[name="label"]').scrollIntoViewIfNeeded();
  await expect(form.locator('[name="label"]')).toBeInViewport();
  expect(await overflow(), 'the create form scrolls sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoSeriousAxe(page, 'the create form at 360px');
});

test('locale=en-XA renders every string of the studio and its forms as pseudo text, tenant data excepted @p18-studio @p18-studio-pseudo', async ({ page }) => {
  await openStudio(page, {}, '?locale=en-XA');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  const report = (scope: Locator) =>
    scope.evaluate((element, servedJson) => {
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
        // An ISO currency code on its own (NGN, GHS, KES, ZAR) is a code, not copy.
        if (/^[A-Z]{3}$/.test(text)) continue;
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

  const list = await report(screenOf(page));
  expect(list.english, 'strings on the studio that did not come through i18n').toEqual([]);
  expect(list.forged, 'UI copy marked data-record-text that is not served tenant data').toEqual([]);
  expect(list.pseudoCount, 'almost no pseudo text: the check saw nothing').toBeGreaterThanOrEqual(5);
  const create = await openCreate(page);
  await choose(create, 'type', 'currency');
  await choose(create, 'classification', 'pii');
  const form = await report(create);
  expect(form.english, 'strings in the create form that did not come through i18n').toEqual([]);
  await create.getByTestId('field-cancel').click();
  const edit = await openEdit(page, PICKLIST);
  await choose(edit, 'classification', 'sensitive');
  expect((await report(edit)).english, 'strings in the edit form that did not come through i18n').toEqual([]);
  await edit.getByTestId('field-cancel').click();
  await row(page, BOOLEAN).getByTestId('field-retire').click();
  expect((await report(shown(page.locator(DIALOG)).first())).english, 'strings in the retire dialog that did not come through i18n').toEqual([]);
});

// ===========================================================================
// The real API, once
// ===========================================================================

test('on the real API: the seeded admin creates, relabels and retires a field, and an agent is refused @p18-studio @p18-studio-live', async ({ browser }) => {
  // No interception. A deal field, `none`, unique per run and retired at the
  // end, so no other spec's reads change: a `none` field withholds nothing and
  // a retired key appears in no read.
  const suffix = Date.now().toString(36);
  const apiName = `qa_studio_${suffix}__c`;
  const label = `Sample studio ${suffix}`;
  const admin = await browser.newContext({ extraHTTPHeaders: { 'x-kasuwa-tenant-id': LIVE_ADMIN.tenantId, 'x-kasuwa-user-id': LIVE_ADMIN.userId } });
  const page = await admin.newPage();
  const response = await page.goto(`${studioUrl()}${STUDIO_ROUTE}`);
  expect(response?.status()).toBe(200);
  await expect(screenOf(page)).toBeVisible();
  await selectObject(page, 'deal');
  const form = await openCreate(page);
  await fillNew(form, { label, apiName, type: 'text' });
  const created = await save(page, form);
  expect((await created.response())?.status(), 'the real API refused the studio’s create').toBe(201);
  await expectClosed(page, 'a live create');
  await expect(row(page, apiName)).toBeVisible();

  await page.reload();
  await selectObject(page, 'deal');
  await expect(row(page, apiName), 'the field did not survive a reload').toBeVisible();
  const edit = await openEdit(page, apiName);
  await edit.locator('[name="label"]').fill(`${label} relabelled`);
  const updated = await save(page, edit);
  expect((await updated.response())?.status(), 'the real API refused the studio’s update').toBe(200);
  await page.reload();
  await selectObject(page, 'deal');
  await expect.poll(async () => visibleText(row(page, apiName))).toContain(`${label} relabelled`);

  await row(page, apiName).getByTestId('field-retire').click();
  const sent = page.waitForRequest((request) => isWrite(request));
  await shown(page.locator(DIALOG)).first().getByTestId('retire-confirm').click();
  expect((await (await sent).response())?.status(), 'the real API refused the studio’s retire').toBe(200);
  await expect(row(page, apiName)).toHaveCount(0);
  await showRetired(page, true);
  await expect(row(page, apiName)).toHaveAttribute('data-retired', 'true');
  await admin.close();

  const agent = await browser.newContext({ extraHTTPHeaders: { 'x-kasuwa-tenant-id': TENANT_A, 'x-kasuwa-user-id': USER_A_AGENT_1 } });
  const agentPage = await agent.newPage();
  await agentPage.goto(`${studioUrl()}${STUDIO_ROUTE}`);
  await expect(screenOf(agentPage)).toBeVisible();
  const refusedForm = await openCreate(agentPage);
  await fillNew(refusedForm, { label: `${label} agent`, apiName: `qa_agent_${suffix}__c`, type: 'text' });
  const refused = await save(agentPage, refusedForm);
  expect((await refused.response())?.status(), 'an agent was allowed to create a custom field').toBe(403);
  await expectSaysOneOf(shown(agentPage.locator('[role="alert"]')), [EN['admin.error.not_permitted'] ?? '<missing>', ...studioLabels('.not_permitted')], 'the agent’s refusal');
  await agent.close();
});

// ===========================================================================
// Budget
// ===========================================================================

test.describe('/admin/custom-fields on the wire', () => {
  test('/admin/custom-fields stays inside its transferred-byte budget on the production build @p18-studio @p18-studio-budget', async ({ page }) => {
    // No fake clock here: it replaces window.performance, so the first
    // contentful paint this measures would never be reported (D-L118).
    active = await installCustomFieldsMock(page);
    const metrics = await measurePageLoad(page, `${studioUrl()}${STUDIO_ROUTE}`, 'default');

    const record = resolve(__dirname, '.artifacts', 'p18-studio-budget.json');
    mkdirSync(resolve(__dirname, '.artifacts'), { recursive: true });
    writeFileSync(record, `${JSON.stringify({ path: STUDIO_ROUTE, transferredBytes: metrics.transferredBytes, budget: STUDIO_BUDGET_BYTES }, null, 2)}\n`, 'utf8');

    // Bytes from `next dev` are not a budget (D-L28): prove this is the build.
    const html = await page.content();
    const built = readFileSync(resolve(__dirname, '..', '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
    expect(servedBuildId(html), 'webStudioUrl is not serving the production build').toBe(built);
    // A 404 page is small: a budget met by the not-found page measures nothing.
    await expect(screenOf(page)).toBeVisible();

    expect(STUDIO_BUDGET_BYTES).toBeLessThan(300_000);
    assertWithinByteBudget('P18 the customisation studio', metrics.transferredBytes, STUDIO_BUDGET_BYTES);
  });

  test('/admin/custom-fields paints within 5 s at 256 kbps and 300 ms @p18-studio @p18-studio-budget', async ({ page }) => {
    active = await installCustomFieldsMock(page);
    const metrics = await measurePageLoad(page, `${studioUrl()}${STUDIO_ROUTE}`, 'low-bandwidth');
    await expect(screenOf(page)).toBeVisible();
    expect(metrics.fcpMs, 'first contentful paint on the PRD 2.13 link').toBeLessThan(5_000);
  });
});
