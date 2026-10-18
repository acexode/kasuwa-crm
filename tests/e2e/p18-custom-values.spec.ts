import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stack, type StackUrls } from './support/stack';
import {
  ACCOUNT_FIELDS,
  ACTIVITY_FIELDS,
  CONTACT_FIELDS,
  CustomFieldsServer,
  DEAL_FIELDS,
  WITHHELD_SENTINELS,
  fieldOf,
  picklistLabel,
  servedCustomData,
  type CustomFieldDefinition,
  type CustomFieldsSetup,
  type CustomObject,
} from './support/custom-fields-mock';
import {
  CONTACT_CLAIMABLE,
  CONTACT_FULL,
  CONTACT_LOCKED,
  CONTACT_NULLS,
  PROGRAMME_ONE as CONTACT_PROGRAMME_ONE,
  PROGRAMME_TWO as CONTACT_PROGRAMME_TWO,
  installContactRecordMock,
  isCreateActivity as isContactCreateActivity,
  isUpdateContact,
  servedData as contactServedData,
  type ContactRecordMock,
  type ContactRecordMockOptions,
} from './support/contact-record-mock';
import {
  ACCOUNT_FULL,
  installAccountRecordMock,
  isUpdateAccount as isRecordUpdateAccount,
  type AccountRecordMockOptions,
} from './support/account-record-mock';
import { X_FULL, installDealMock, isUpdateDeal, type DealMockOptions } from './support/deal-mock';
import { NOW as PIPELINE_NOW, PIPELINE_ONE, PIPELINE_TWO, baseDeals, installPipelineMock, isListDeals } from './support/pipeline-mock';
import {
  CONTACT_EXAMPLE as LIST_CONTACT,
  OTHER_PROGRAMME_ID as LIST_OTHER_PROGRAMME,
  ROW_NULLS as LIST_ROW_NULLS,
  ROW_PAGE_TWO as LIST_ROW_PAGE_TWO,
  installRecordsMock,
  isListContacts,
} from './support/records-mock';
import { LEAD_EXAMPLE, LEAD_NEW, installLeadsMock, isListLeads } from './support/leads-mock';
import { ACCOUNT_EXAMPLE as LIST_ACCOUNT, ROW_NULLS as LIST_ACCOUNT_NULLS, installAccountsMock, isListAccounts } from './support/accounts-mock';
import {
  NOW as ACTIVITIES_NOW,
  PICK_CONTACT,
  installActivitiesMock,
  isCreateActivity as isComposerCreateActivity,
} from './support/activities-mock';

/**
 * T-0091 — custom-field values on the record screens, and the two supported
 * list filters, behind the custom-fields flag (ADR-0016, D-L128, D-L138 to
 * D-L143). Written by the lead's QA agent BEFORE the work exists (D-L23);
 * `tests/acceptance/records-ui/custom-values.acceptance.test.ts` runs this
 * file with `--grep @p18-custom-values` and reads every outcome by tag.
 *
 * TAG RULE (D-L84). `@p18-custom-values` is the parent tag; every sub-tag is
 * `@p18-custom-values-<name>`. The suite checks that no other spec carries a
 * tag this one's grep matches, and that no other spec's parent tag matches
 * ours (T-0090's studio, written in parallel, included).
 *
 * ---------------------------------------------------------------------------
 * THE FLAG AND THE PROCESS
 *
 *   `crm_custom_fields` — the flag T-0090's studio suite pins (default OFF,
 *   not production-ready; name confirmed by the lead), shared by the record
 *   screens and read on the server. The builder adds it to the RECORDS web process in
 *   `scripts/run-e2e.mjs` (beside crm_records, crm_accounts, crm_record_view,
 *   crm_leads, crm_activities, crm_pipeline) in the change that registers it.
 *   Every journey here runs on `webRecordsUrl`, the process every screen
 *   below already rides on. Naming an unregistered flag there stops the
 *   process booting, which is why this suite does not add it (as T-0087 R3).
 *
 *   With the flag OFF the screens are unchanged: no process serves a record
 *   screen with it off, so that half is held statically by the acceptance
 *   suite. With it ON and NO definitions, every older records-ui suite runs
 *   (their mocks now answer listCustomFields with an empty list) and must
 *   still pass inside its pinned byte budget. These journeys are the
 *   flag-ON-with-definitions half.
 *
 * EVERY JOURNEY INSTALLS AN EXISTING SCREEN MOCK WITH A `customFields` SETUP
 *
 * The record and list mocks (contact record, account record, deal, pipeline,
 * records, leads, accounts, activities) serve listCustomFields and the
 * projected `custom` through `support/custom-fields-mock.ts`, which checks
 * every patch, create and filter the screen sends (see its header). Every
 * mock's own checks still run, so a save that round-trips a standard field it
 * did not change is refused here as it always was. `afterEach` fails a test
 * with any violation or mock fault.
 *
 * THE DOM HOOKS THIS FILE RELIES ON (the builder's side of the contract)
 *
 *   [data-custom-field="<apiName>"]        one slot per ACTIVE definition the
 *                                          screen read, on the record view
 *                                          (P05/01 contact and lead, P05/04
 *                                          account, P06/05 deal), outside any
 *                                          dialog; never one for a retired
 *                                          field or a key it has no definition
 *                                          for
 *     the definition's label               drawn as record data
 *                                          ([data-record-text]: tenant data,
 *                                          not UI copy)
 *     [data-custom-value]                  the value alone, formatted (below);
 *                                          absent on a withheld slot
 *     data-locked="true"                   on a WITHHELD key: the screens'
 *                                          existing treatment, the lock icon
 *                                          and `records.locked`, nothing else
 *   [data-custom-input="<apiName>"]        in the screen's existing edit form
 *                                          (`contact-sheet`, `account-sheet`,
 *                                          `deal-sheet`) and activity forms
 *                                          (`activity-form`, the P07
 *                                          `activity-composer`): one per
 *                                          active, readable key; NONE for a
 *                                          withheld key. picklist and boolean:
 *                                          a native <select> whose "" option
 *                                          is "no value" (picklist options:
 *                                          value = the api value, text = the
 *                                          label; boolean: "true" / "false",
 *                                          text = a translated yes / no).
 *                                          date: input[type="date"]. text,
 *                                          number and currency: an <input>
 *                                          that is never type="number" (a
 *                                          float loses digits); currency in
 *                                          major units, the field's currency
 *                                          fixed.
 *   [data-filter="custom.<apiName>"]       on the contacts, leads and accounts
 *                                          lists and the pipeline's LIST view:
 *                                          a <select>, or a chip opening
 *     [data-filter-menu="custom.<apiName>"] with [data-filter-option="<value>"]
 *                                          (a picklist value, or true/false)
 *                                          and [data-filter-option="is-empty"]
 *                                          ("is empty"; `-` can never be in a
 *                                          picklist value), and an optional
 *                                          [data-testid="filter-apply"]. Only
 *                                          for active picklist and boolean
 *                                          fields.
 *   [role="alert"]                         a refused custom write or filter,
 *                                          inside the form or the list
 *   [data-record-text]                     record data, not UI copy (en-XA)
 *
 * FORMATS (in the caller's locale, the page's `<html lang>`)
 *
 *   - currency: the value element's text IS the browser's own
 *     `Intl.NumberFormat(lang, {style: 'currency', currency: <the FIELD's
 *     code>, currencyDisplay})` of the exact decimal (minor units over 100,
 *     done in strings), for symbol, narrowSymbol, code or name. Never a float
 *     (an 18-digit amount keeps every digit), never compact, never a
 *     hard-coded symbol, never another currency.
 *   - number: every digit of the stored decimal, in the locale's separators
 *     (grouped or not); never rounded.
 *   - date: a `<time datetime="YYYY-MM-DD">` whose text is the browser's
 *     `Intl.DateTimeFormat(lang, {dateStyle, timeZone: 'UTC'})` for one of
 *     the four styles: the CALENDAR date, the same in every zone (the
 *     journey runs a browser in Atlantic/Cape_Verde, UTC-1, where reading it
 *     as a UTC instant shows the day before).
 *   - picklist: the definition's LABEL, never the stored value.
 *   - boolean: a translated label (an en.json id containing `custom` ending
 *     `.boolean.true` / `.yes` / `.true`, and the false twins), never
 *     "true" or "false".
 *   - text: as served, as text (markup is never parsed).
 *   - empty (a defined key with no value): not locked, no value, at most the
 *     screen's existing "not set" copy (`records.cell.empty`).
 *
 * EDITS (D-L84: there is no capability read)
 *
 *   - A save carries `custom` with ONLY the keys the person changed, through
 *     the screen's existing update (updateContact, updateAccount,
 *     updateDeal), beside `version` and any standard field changed. A value
 *     sets; clearing sends `null`. A picklist sends its value, a currency
 *     `{amountMinor, currency}` in the field's currency as an integer string,
 *     a number its canonical decimal string, a date `YYYY-MM-DD`, a boolean
 *     a JSON boolean.
 *   - A create (an activity form) carries values only: no `null`, no empty
 *     key.
 *   - Refusals are localised: `invalid_value`, `custom_too_large`,
 *     `unknown_field` and `field_not_editable` each draw a translated message
 *     (an en.json id containing `custom` ending with the code, snake or
 *     camel case), never the raw code.
 *   - Read-only keys: the wire cannot show `read` before a write, so a key
 *     answered `403 field_not_editable` becomes read-only on the form and is
 *     never sent again in that session.
 *
 * FILTERS (D-L128 Q4)
 *
 *   `custom[<key>]=<value>` for equality, `customEmpty=<key>` for "is
 *   empty", only for active picklist and boolean fields, one value per key;
 *   never a custom sort. `400 field_withheld` draws a translated message (an
 *   en.json id containing `custom` ending `.field_withheld` or
 *   `.fieldWithheld`), not the generic validation one.
 *
 * WHAT IS NOT HELD IN THE BROWSER, AND WHY
 *
 *   - Activity VALUES on a read: `MyActivity` (P07's lists) carries no
 *     `custom`, and a timeline item carries none, so no screen reads an
 *     activity's values. The activity forms are held (create).
 *   - The lead's record IS the contact record (D-P17: a lead is a contact);
 *     `@p18-custom-values-lead` opens a contact at a lead status there. The
 *     Leads list is held through its filter.
 *   - The byte budgets: no new route. Every other records-ui suite runs with
 *     the flag on and keeps its pinned budget; that is the budget check.
 * ---------------------------------------------------------------------------
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PSEUDO = /[·[\]äëïöüÄËÏÖÜ]/;

const CONTACT_SCREEN = '[data-screen="P05/01"]';
const ACCOUNT_SCREEN = '[data-screen="P05/04"]';
const DEAL_SCREEN = '[data-screen="P06/05"]';
const CONTACTS_SCREEN = '[data-screen="P04/02"]';
const LEADS_SCREEN = '[data-screen="P04/01"]';
const ACCOUNTS_SCREEN = '[data-screen="P04/03"]';
const PIPELINE_SCREEN = '[data-screen="P06/01"]';
const ACTIVITIES_SCREEN = '[data-screen="P07"]';

const EN = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'), 'utf8')) as Record<string, string>;

// Kasuwa's users are in WAT/EAT/SAST. One describe below runs in Cape Verde (UTC-1).
test.use({ timezoneId: 'Africa/Lagos' });

// ---------------------------------------------------------------------------
// Fixtures: the stored values each journey plants
// ---------------------------------------------------------------------------

const CONTACT_VALUES = {
  alternate_name__c: WITHHELD_SENTINELS.contact,
  credit_limit__c: { amountMinor: '125000050', currency: 'NGN' },
  legacy_ref__c: WITHHELD_SENTINELS.retiredContact,
  renewal_date__c: '2027-03-01',
  risk_band__c: 'medium',
  satisfaction_score__c: '7.5',
  service_note__c: 'Prefers morning calls',
  tier__c: 'platinum',
  vip__c: true,
} as const;

/** CONTACT_FULL is in programme one (alternate_name withheld); CONTACT_LOCKED in two (vip withheld). */
function contactSetup(extra: Partial<CustomFieldsSetup> = {}): CustomFieldsSetup {
  return {
    values: {
      [CONTACT_FULL.id]: CONTACT_VALUES,
      [CONTACT_LOCKED.id]: { alternate_name__c: 'Chidi Alternate', vip__c: false, tier__c: 'silver' },
      [CONTACT_CLAIMABLE.id]: { tier__c: 'gold', vip__c: false, renewal_date__c: '2026-12-31' },
      [CONTACT_NULLS.id]: { tier__c: 'gold' },
    },
    withheld: { contact: { [CONTACT_PROGRAMME_ONE.id]: ['alternate_name__c'], [CONTACT_PROGRAMME_TWO.id]: ['vip__c'] } },
    ...extra,
  };
}

const ACCOUNT_VALUES = {
  contract_value__c: { amountMinor: '98765432', currency: 'GHS' },
  internal_rating__c: WITHHELD_SENTINELS.account,
  key_account__c: true,
  old_code__c: WITHHELD_SENTINELS.retiredAccount,
  review_date__c: '2026-11-30',
  segment__c: 'public_sector',
} as const;

function accountSetup(extra: Partial<CustomFieldsSetup> = {}): CustomFieldsSetup {
  return {
    values: { [ACCOUNT_FULL.id]: ACCOUNT_VALUES },
    withheld: { account: { [ACCOUNT_FULL.programmeId]: ['internal_rating__c'] } },
    ...extra,
  };
}

const DEAL_PROGRAMME = [PIPELINE_ONE, PIPELINE_TWO].find((pipeline) => pipeline.id === X_FULL.pipelineId)?.programmeId ?? '';

const DEAL_VALUES = {
  go_live__c: '2026-12-01',
  margin__c: { amountMinor: '4500000', currency: 'ZAR' },
  old_stage__c: WITHHELD_SENTINELS.retiredDeal,
  partner_led__c: false,
  source_channel__c: 'tender',
  win_reason__c: WITHHELD_SENTINELS.deal,
} as const;

function dealSetup(extra: Partial<CustomFieldsSetup> = {}): CustomFieldsSetup {
  return {
    values: { [X_FULL.id]: DEAL_VALUES },
    withheld: { deal: { [DEAL_PROGRAMME]: ['win_reason__c'] } },
    ...extra,
  };
}

const ALL_SENTINELS: readonly string[] = Object.values(WITHHELD_SENTINELS);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Watched {
  violations: string[];
  faults: string[];
}

let active: Watched | undefined;
let traffic: { url: string; body: string }[] = [];

function watch<T extends { violations: string[] }>(mock: T): T {
  const faults = (mock as T & { mockFaults?: string[] }).mockFaults ?? [];
  active = { violations: mock.violations, faults };
  return mock;
}

test.beforeEach(({ page }) => {
  traffic = [];
  page.on('request', (request) => {
    traffic.push({ url: request.url(), body: request.postData() ?? '' });
  });
});

test.afterEach(async ({ page }) => {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.faults, 'the MOCK answered with something its contract refuses').toEqual([]);
    expect(mock.violations, 'the screen sent the API something the contract or the custom-field rules refuse').toEqual([]);
  }
});

function recordsUrl(): string {
  const urls = stack() as StackUrls & { webRecordsUrl?: string };
  if (typeof urls.webRecordsUrl !== 'string' || urls.webRecordsUrl === '') {
    throw new Error('the stack file has no webRecordsUrl: scripts/run-e2e.mjs starts no records web process');
  }
  return urls.webRecordsUrl;
}

/** Visible elements only: a screen may render desktop and mobile layouts and switch them with CSS. */
function shown(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

/**
 * Text a person can see or hear: aria-hidden subtrees (icon ligatures)
 * removed, whitespace folded. `\s` covers the no-break spaces Intl puts in
 * currencies and dates (U+00A0, U+202F).
 */
async function visibleText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

function fold(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function digits(text: string): string {
  return text.replace(/\D/g, '');
}

function json(body: unknown): Record<string, unknown> {
  expect(typeof body === 'object' && body !== null && !Array.isArray(body), 'the write body is not an object').toBe(true);
  return body as Record<string, unknown>;
}

function lockIcon(scope: Locator): Locator {
  // `<Icon name="lock" />` is an aria-hidden ligature span whose text is its name.
  return scope.locator('[aria-hidden="true"]', { hasText: /^\s*lock\s*$/ });
}

async function isDisabled(locator: Locator): Promise<boolean> {
  return locator.evaluate(
    (element) =>
      (element as HTMLInputElement).disabled === true ||
      (element as HTMLInputElement).readOnly === true ||
      element.getAttribute('aria-disabled') === 'true' ||
      element.getAttribute('aria-readonly') === 'true',
  );
}

/** en.json labels under an id containing `custom` ending with one of `suffixes`. */
function customLabels(...suffixes: string[]): string[] {
  return Object.entries(EN)
    .filter(([id]) => /custom/i.test(id) && suffixes.some((suffix) => id.endsWith(suffix)))
    .map(([, text]) => text);
}

const CODE_SUFFIXES: Readonly<Record<string, readonly string[]>> = {
  invalid_value: ['.invalid_value', '.invalidValue'],
  custom_too_large: ['.custom_too_large', '.customTooLarge', '.tooLarge', '.too_large'],
  unknown_field: ['.unknown_field', '.unknownField'],
  field_not_editable: ['.field_not_editable', '.fieldNotEditable', '.notEditable', '.not_editable'],
  field_withheld: ['.field_withheld', '.fieldWithheld'],
};

function errorLabels(code: string): string[] {
  return customLabels(...(CODE_SUFFIXES[code] ?? [`.${code}`]));
}

function yesLabels(): string[] {
  return customLabels('.boolean.true', '.yes', '.true');
}

function noLabels(): string[] {
  return customLabels('.boolean.false', '.no', '.false');
}

async function expectSaysOneOf(locator: Locator, labels: readonly string[], what: string): Promise<void> {
  expect(labels.length, `en.json has no label for ${what}`).toBeGreaterThan(0);
  const said = await visibleText(locator);
  expect(labels.some((label) => said.includes(fold(label))), `${what}: "${said}" says none of ${labels.map((label) => `"${label}"`).join(', ')}`).toBe(true);
}

async function expectNoSeriousAxe(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const blocking = results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
  expect(blocking.map((violation) => `${violation.id}: ${violation.help}`), `serious or critical accessibility violations on ${label}`).toEqual([]);
  expect(results.passes.length, 'axe checked nothing').toBeGreaterThan(0);
}

/** Nothing withheld or retired anywhere: the DOM (text, attributes, form values), the title, and every request the page made. */
async function expectNoLeak(page: Page, sentinels: readonly string[], where: string): Promise<void> {
  const dump = await page.evaluate(() => {
    const out: string[] = [document.title, document.documentElement.outerHTML];
    for (const element of Array.from(document.querySelectorAll('input, textarea, select'))) {
      out.push((element as HTMLInputElement).value);
    }
    return out.join('\n');
  });
  for (const sentinel of sentinels) {
    expect(dump.includes(sentinel), `a withheld or retired value reached the page (${where})`).toBe(false);
    const sent = traffic.filter((entry) => `${entry.url}\n${entry.body}`.includes(sentinel)).map((entry) => entry.url);
    expect(sent, `a withheld or retired value went out in a request the page made (${where})`).toEqual([]);
  }
}

// ----- formats, computed by the browser's own Intl in the page's language ---

/** `125000050` minor units → `1250000.50`, in strings (every Phase 2 currency has two minor digits). */
function minorToDecimal(amountMinor: string): string {
  const negative = amountMinor.startsWith('-');
  const unsigned = (negative ? amountMinor.slice(1) : amountMinor).padStart(3, '0');
  return `${negative ? '-' : ''}${unsigned.slice(0, -2)}.${unsigned.slice(-2)}`;
}

async function pageLang(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.lang || 'en');
}

async function currencyForms(page: Page, decimal: string, currency: string): Promise<string[]> {
  return page.evaluate(
    ([value, code]) => {
      const lang = document.documentElement.lang || 'en';
      const out = new Set<string>();
      for (const currencyDisplay of ['symbol', 'narrowSymbol', 'code', 'name'] as const) {
        try {
          const format = new Intl.NumberFormat(lang, { style: 'currency', currency: code, currencyDisplay });
          out.add((format.format as unknown as (input: string) => string)(value).replace(/\s+/g, ' ').trim());
        } catch {
          // A language this browser has no data for.
        }
      }
      return [...out];
    },
    [decimal, currency] as const,
  );
}

async function numberForms(page: Page, decimal: string): Promise<string[]> {
  return page.evaluate((value) => {
    const lang = document.documentElement.lang || 'en';
    const out = new Set<string>();
    for (const useGrouping of [true, false]) {
      const format = new Intl.NumberFormat(lang, { maximumFractionDigits: 20, useGrouping });
      out.add((format.format as unknown as (input: string) => string)(value).replace(/\s+/g, ' ').trim());
    }
    return [...out];
  }, decimal);
}

async function dateForms(page: Page, isoDate: string): Promise<string[]> {
  return page.evaluate((iso) => {
    const lang = document.documentElement.lang || 'en';
    const [year, month, day] = iso.split('-').map(Number);
    const at = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
    const out = new Set<string>();
    for (const dateStyle of ['short', 'medium', 'long', 'full'] as const) {
      out.add(new Intl.DateTimeFormat(lang, { dateStyle, timeZone: 'UTC' }).format(at).replace(/\s+/g, ' ').trim());
    }
    return [...out];
  }, isoDate);
}

// ----- slots and inputs -------------------------------------------------------

function slot(page: Page, root: string, key: string): Locator {
  return shown(page.locator(`${root} [data-custom-field="${key}"]`)).first();
}

function valueOf(scope: Locator): Locator {
  return scope.locator('[data-custom-value]').first();
}

/** The keys drawn on the record view, outside any dialog, in DOM order, once each. */
async function drawnKeys(page: Page, root: string): Promise<string[]> {
  const keys = await page.locator(`${root} [data-custom-field]`).evaluateAll((elements) =>
    elements
      .filter((element) => element.closest('[role="dialog"]') === null && (element as HTMLElement).offsetParent !== null)
      .map((element) => element.getAttribute('data-custom-field') ?? ''),
  );
  return [...new Set(keys)];
}

function activeKeys(fields: readonly CustomFieldDefinition[]): string[] {
  return fields.filter((field) => field.retiredAt === null).map((field) => field.apiName);
}

async function expectCurrency(page: Page, locator: Locator, money: { amountMinor: string; currency: string }, what: string): Promise<void> {
  const said = await visibleText(locator);
  expect(digits(said), `${what}: "${said}" is not exactly ${money.amountMinor} minor units`).toBe(money.amountMinor.replace(/^-/, '').padStart(3, '0'));
  const forms = await currencyForms(page, minorToDecimal(money.amountMinor), money.currency);
  expect(forms, `${what}: "${said}" is not the browser's own ${money.currency} format in ${await pageLang(page)} (${forms.join(' | ')})`).toContain(said);
}

async function expectNumber(page: Page, locator: Locator, decimal: string, what: string): Promise<void> {
  const said = await visibleText(locator);
  expect(digits(said), `${what}: "${said}" lost or added digits of ${decimal}`).toBe(digits(decimal));
  const forms = await numberForms(page, decimal);
  expect(forms, `${what}: "${said}" is not ${decimal} in the locale's separators (${forms.join(' | ')})`).toContain(said);
}

async function expectCalendarDate(page: Page, locator: Locator, isoDate: string, what: string): Promise<void> {
  const time = locator.locator('time').first();
  await expect(time, `${what}: the date is not in a <time>`).toHaveAttribute('datetime', isoDate);
  const said = await visibleText(time);
  const forms = await dateForms(page, isoDate);
  expect(forms, `${what}: "${said}" is not the calendar date ${isoDate} in ${await pageLang(page)} (${forms.join(' | ')})`).toContain(said);
}

/** One slot shows its stored value, formatted for its type. */
async function expectShown(page: Page, root: string, object: CustomObject, key: string, stored: unknown): Promise<void> {
  const field = fieldOf(object, key);
  const where = slot(page, root, key);
  await expect(where, `no slot for ${object}.${key}`).toBeVisible();
  await expect(where, `${key} is drawn as withheld`).not.toHaveAttribute('data-locked', 'true');
  const labelled = await where.locator('[data-record-text]').allTextContents();
  expect(labelled.some((text) => fold(text).includes(field.label)), `${key}: its label "${field.label}" is not drawn as record data`).toBe(true);
  const value = valueOf(where);
  await expect(value, `${key}: no [data-custom-value]`).toBeVisible();
  switch (field.type) {
    case 'currency':
      await expectCurrency(page, value, stored as { amountMinor: string; currency: string }, key);
      break;
    case 'number':
      await expectNumber(page, value, String(stored), key);
      break;
    case 'date':
      await expectCalendarDate(page, value, String(stored), key);
      break;
    case 'picklist': {
      const label = picklistLabel(object, key, String(stored));
      expect(await visibleText(value), `${key}: the picklist label, never the value "${String(stored)}"`).toBe(label);
      break;
    }
    case 'boolean': {
      const said = await visibleText(value);
      expect(['true', 'false'].includes(said.toLowerCase()), `${key}: a boolean drawn as "${said}"`).toBe(false);
      await expectSaysOneOf(value, stored === true ? yesLabels() : noLabels(), `${key} (${String(stored)})`);
      break;
    }
    default:
      expect(await visibleText(value), `${key}: the text as served`).toBe(fold(String(stored)));
  }
}

async function expectWithheldSlot(page: Page, root: string, key: string): Promise<void> {
  const where = slot(page, root, key);
  await expect(where, `no slot for the withheld ${key}: its position shows the withheld treatment`).toBeVisible();
  await expect(where).toHaveAttribute('data-locked', 'true');
  await expect(lockIcon(where), `${key}: no lock icon`).toHaveCount(1);
  await expect(where.locator('[data-custom-value]'), `${key}: a withheld slot draws a value element`).toHaveCount(0);
  expect(await visibleText(where), `${key}: not the screens' "Restricted" label`).toContain(EN['records.locked'] ?? 'records.locked');
}

async function expectEmptySlot(page: Page, root: string, object: CustomObject, key: string): Promise<void> {
  const where = slot(page, root, key);
  await expect(where, `no slot for the empty ${key}`).toBeVisible();
  await expect(where, `${key}: no value is not withheld`).not.toHaveAttribute('data-locked', 'true');
  await expect(lockIcon(where)).toHaveCount(0);
  const rest = fold((await visibleText(where)).replace(fieldOf(object, key).label, ''));
  expect(['', fold(EN['records.cell.empty'] ?? '')], `${key}: an empty value draws "${rest}"`).toContain(rest);
}

function customInput(scope: Locator, key: string): Locator {
  return scope.locator(`[data-custom-input="${key}"]`).first();
}

async function setCustom(scope: Locator, object: CustomObject, key: string, value: string): Promise<void> {
  const input = customInput(scope, key);
  await expect(input, `no [data-custom-input="${key}"]`).toBeVisible();
  const type = fieldOf(object, key).type;
  if (type === 'picklist' || type === 'boolean') {
    await input.selectOption(value);
  } else {
    await input.fill(value);
  }
}

async function inputKeys(scope: Locator): Promise<string[]> {
  return scope.locator('[data-custom-input]').evaluateAll((elements) =>
    elements.filter((element) => (element as HTMLElement).offsetParent !== null).map((element) => element.getAttribute('data-custom-input') ?? ''),
  );
}

/** The inputs' shapes: a <select> for picklist and boolean, a date input, never type="number". */
async function expectInputShapes(scope: Locator, object: CustomObject, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    const field = fieldOf(object, key);
    const input = customInput(scope, key);
    const shape = await input.evaluate((element) => ({ tag: element.tagName, type: element.getAttribute('type') ?? '' }));
    if (field.type === 'picklist' || field.type === 'boolean') {
      expect(shape.tag, `${key} (${field.type}) is not a native <select>`).toBe('SELECT');
      const options = await input.locator('option').evaluateAll((elements) =>
        elements.map((element) => ({ value: (element as HTMLOptionElement).value, text: (element.textContent ?? '').replace(/\s+/g, ' ').trim() })),
      );
      expect(options[0]?.value, `${key}: the first option is not "no value"`).toBe('');
      if (field.type === 'picklist') {
        expect(options.slice(1).map((option) => option.value), `${key}: the options are not the picklist values`).toEqual((field.config.values ?? []).map((entry) => entry.value));
        for (const option of options.slice(1)) {
          expect(option.text, `${key}: option ${option.value} is not labelled with its label`).toBe(picklistLabel(object, key, option.value));
        }
      } else {
        expect(options.slice(1).map((option) => option.value).sort(), `${key}: a boolean offers true and false`).toEqual(['false', 'true']);
        for (const option of options.slice(1)) {
          expect(['true', 'false'].includes(option.text.toLowerCase()), `${key}: an option says "${option.text}"`).toBe(false);
          expect((option.value === 'true' ? yesLabels() : noLabels()).map(fold), `${key}: option ${option.value} is not a translated yes/no`).toContain(option.text);
        }
      }
    } else if (field.type === 'date') {
      expect(shape, `${key} is not an input[type="date"]`).toEqual({ tag: 'INPUT', type: 'date' });
    } else {
      expect(shape.tag, `${key} is not an <input>`).toBe('INPUT');
      expect(shape.type, `${key} is type="number": a float loses digits`).not.toBe('number');
    }
  }
}

// ----- opening the screens ---------------------------------------------------

async function openContact(page: Page, id: string, options: ContactRecordMockOptions & { query?: string } = {}): Promise<ContactRecordMock> {
  const mock = watch(await installContactRecordMock(page, options));
  const response = await page.goto(`${recordsUrl()}/contacts/${id}${options.query ?? ''}`);
  expect(response?.status(), '/contacts/<id> on the records process').toBe(200);
  await expect(page.locator(CONTACT_SCREEN)).toHaveAttribute('data-record-state', 'ready');
  return mock;
}

async function openAccount(page: Page, options: AccountRecordMockOptions & { query?: string } = {}) {
  const mock = watch(await installAccountRecordMock(page, { recordId: ACCOUNT_FULL.id, ...options }));
  const response = await page.goto(`${recordsUrl()}/accounts/${ACCOUNT_FULL.id}${options.query ?? ''}`);
  expect(response?.status(), '/accounts/<id> on the records process').toBe(200);
  await expect(page.locator(ACCOUNT_SCREEN)).toHaveAttribute('data-record-state', 'ready');
  return mock;
}

async function openDeal(page: Page, options: DealMockOptions = {}) {
  await page.clock.setFixedTime(new Date(PIPELINE_NOW));
  const mock = watch(await installDealMock(page, options));
  const response = await page.goto(`${recordsUrl()}/deals/${X_FULL.id}`);
  expect(response?.status(), '/deals/<id> on the records process').toBe(200);
  await expect(page.locator(DEAL_SCREEN)).toHaveAttribute('data-record-state', 'ready');
  return mock;
}

async function openSheet(page: Page, root: string, action: string, testId: string): Promise<Locator> {
  await shown(page.locator(`${root} [data-action="${action}"]`)).first().click();
  const sheet = shown(page.getByTestId(testId)).first();
  await expect(sheet, `${action} opened no ${testId}`).toBeVisible();
  await expect(sheet).toHaveAttribute('role', 'dialog');
  return sheet;
}

async function openLog(page: Page, type: string): Promise<Locator> {
  const typed = () => shown(page.locator(`[data-action="log-activity"][data-activity-type="${type}"]`));
  if ((await typed().count()) === 0) {
    await shown(page.locator(`${CONTACT_SCREEN} [data-action="log-activity"]:not([data-activity-type])`)).first().click();
  }
  await typed().first().click();
  const form = shown(page.getByTestId('activity-form')).first();
  await expect(form, `logging a ${type} opens no activity form`).toBeVisible();
  return form;
}

// ----- list filters ----------------------------------------------------------

/** The custom filters a list offers, by key. */
async function offeredCustomFilters(page: Page, root: string): Promise<string[]> {
  const params = await page.locator(`${root} [data-filter^="custom."]`).evaluateAll((elements) =>
    elements.filter((element) => (element as HTMLElement).offsetParent !== null).map((element) => element.getAttribute('data-filter') ?? ''),
  );
  return [...new Set(params)].map((param) => param.slice('custom.'.length)).sort();
}

/** The options a custom filter offers: value → what it says. */
async function customFilterOptions(page: Page, root: string, key: string): Promise<Map<string, string>> {
  const control = shown(page.locator(`${root} [data-filter="custom.${key}"]`)).first();
  await expect(control, `no custom.${key} filter`).toBeVisible();
  if ((await control.evaluate((element) => element.tagName)) === 'SELECT') {
    const options = await control.locator('option').evaluateAll((elements) =>
      elements.map((element) => [(element as HTMLOptionElement).value, (element.textContent ?? '').replace(/\s+/g, ' ').trim()] as const),
    );
    return new Map(options.filter(([value]) => value !== ''));
  }
  await control.click();
  const menu = shown(page.locator(`[data-filter-menu="custom.${key}"]`)).first();
  await expect(menu, `the custom.${key} chip opens no menu`).toBeVisible();
  const options = await menu.locator('[data-filter-option]').evaluateAll((elements) =>
    elements.map((element) => {
      const copy = element.cloneNode(true) as Element;
      copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
      return [element.getAttribute('data-filter-option') ?? '', (copy.textContent ?? '').replace(/\s+/g, ' ').trim()] as const;
    }),
  );
  await page.keyboard.press('Escape');
  return new Map(options);
}

async function chooseCustomFilter(page: Page, root: string, key: string, value: string): Promise<void> {
  const control = shown(page.locator(`${root} [data-filter="custom.${key}"]`)).first();
  await expect(control, `no custom.${key} filter`).toBeVisible();
  if ((await control.evaluate((element) => element.tagName)) === 'SELECT') {
    await control.selectOption(value);
    return;
  }
  const option = () => shown(page.locator(`[data-filter-menu="custom.${key}"] [data-filter-option="${value}"]`));
  if ((await option().count()) === 0) await control.click();
  await expect(option().first(), `the custom.${key} filter does not offer "${value}"`).toBeVisible();
  await option().first().click();
  const apply = shown(page.getByTestId('filter-apply'));
  if ((await apply.count()) > 0) await apply.first().click();
}

/** The filters every list must offer, for an object: active picklist and boolean fields. */
function filterable(fields: readonly CustomFieldDefinition[]): string[] {
  return fields.filter((field) => field.retiredAt === null && (field.type === 'picklist' || field.type === 'boolean')).map((field) => field.apiName).sort();
}

async function expectNoCustomSort(page: Page, root: string): Promise<void> {
  await expect(page.locator(`${root} [data-sort-option*="__c"], ${root} [data-column*="__c"], ${root} [data-sort*="__c"]`), 'a sort on a custom field is offered').toHaveCount(0);
  const sorted = traffic.filter((entry) => new URL(entry.url).searchParams.getAll('sort').some((sort) => sort.includes('__c')));
  expect(sorted.map((entry) => entry.url), 'a list was sorted on a custom field').toEqual([]);
}

/** The labels a filter's options must say. */
async function expectFilterOptions(page: Page, root: string, object: CustomObject, key: string): Promise<void> {
  const field = fieldOf(object, key);
  const options = await customFilterOptions(page, root, key);
  expect(options.has('is-empty'), `custom.${key} offers no "is empty"`).toBe(true);
  if (field.type === 'picklist') {
    for (const entry of field.config.values ?? []) {
      expect(options.get(entry.value), `custom.${key}: option ${entry.value} is not labelled "${entry.label}"`).toBe(entry.label);
    }
  } else {
    expect(yesLabels().map(fold), `custom.${key}: "true" is not a translated yes`).toContain(options.get('true') ?? '');
    expect(noLabels().map(fold), `custom.${key}: "false" is not a translated no`).toContain(options.get('false') ?? '');
  }
}

// ===========================================================================
// 0. The mock refuses what the contract refuses (passes before the work, by design)
// ===========================================================================

test('the custom-field mock refuses malformed patches, creates and filters, and projects withheld and retired keys @p18-custom-values @p18-custom-values-mock', () => {
  // A check only ever observed passing proves nothing: every rule the journeys
  // rely on is planted here and must be seen to fire. Passes before T-0091.
  const violations: string[] = [];
  const server = new CustomFieldsServer(
    {
      values: { r1: { tier__c: 'gold', vip__c: true, alternate_name__c: 'withheld', legacy_ref__c: 'retired' } },
      withheld: { contact: { p1: ['alternate_name__c', 'risk_band__c'] } },
      readOnly: { contact: { p1: ['service_note__c'] } },
    },
    violations,
  );
  const fired = (fn: () => unknown): string[] => {
    violations.length = 0;
    fn();
    return [...violations];
  };

  // Reads project: withheld absent and listed (even with no value: risk_band), retired in neither.
  const row = server.decorate({ id: 'r1', withheldFields: [] as string[] }, 'contact', 'r1', 'p1') as { withheldFields: string[]; custom?: Record<string, unknown> };
  expect(row.custom).toEqual({ tier__c: 'gold', vip__c: true });
  expect(row.withheldFields.sort()).toEqual(['custom.alternate_name__c', 'custom.risk_band__c']);

  // listCustomFields: active only, includeRetired=true refused, answer valid.
  const list = server.listAnswer(new URL('http://mock/api/v1/admin/custom-fields?object=contact'));
  expect((list.body.items as { apiName: string }[]).map((item) => item.apiName)).toEqual(activeKeys(CONTACT_FIELDS));
  expect(fired(() => server.listAnswer(new URL('http://mock/api/v1/admin/custom-fields?object=contact&includeRetired=true')))).not.toEqual([]);
  expect(fired(() => server.listAnswer(new URL('http://mock/api/v1/admin/custom-fields?object=lead')))).not.toEqual([]);

  // Patches.
  const patch = (custom: unknown) => server.checkPatch('contact', 'r1', 'p1', custom, 'planted');
  expect(fired(() => expect(patch({ tier__c: 'Gold' })?.body.details).toEqual([{ path: 'custom.tier__c', code: 'invalid_value' }]))).not.toEqual([]);
  expect(fired(() => expect(patch({ tier__c: 'bronze' })?.body.details).toEqual([{ path: 'custom.tier__c', code: 'unknown_value' }]))).not.toEqual([]);
  expect(fired(() => expect(patch({ credit_limit__c: { amountMinor: '100', currency: 'GHS' } })?.body.details).toEqual([{ path: 'custom.credit_limit__c.currency', code: 'currency_mismatch' }]))).not.toEqual([]);
  expect(fired(() => expect(patch({ credit_limit__c: { amountMinor: 100, currency: 'NGN' } })?.status).toBe(400))).not.toEqual([]);
  expect(fired(() => expect(patch({ satisfaction_score__c: '7.50' })?.status).toBe(400))).not.toEqual([]);
  expect(fired(() => expect(patch({ satisfaction_score__c: 7.5 })?.status).toBe(400))).not.toEqual([]);
  expect(fired(() => expect(patch({ renewal_date__c: '2027-02-30' })?.status).toBe(400))).not.toEqual([]);
  expect(fired(() => expect(patch({ vip__c: 'true' })?.status).toBe(400))).not.toEqual([]);
  // service_note__c is read-only on `server` (a 403 comes first): the one-line rule on a server where it is editable.
  const editable = new CustomFieldsServer({}, violations);
  expect(fired(() => expect(editable.checkPatch('contact', 'r2', 'p1', { service_note__c: 'two\nlines' }, 'planted')?.status).toBe(400))).not.toEqual([]);
  expect(fired(() => expect(patch({ alternate_name__c: null })?.status).toBe(403))).not.toEqual([]);
  expect(fired(() => expect(patch({ legacy_ref__c: 'x' })?.body.details).toEqual([{ path: 'custom.legacy_ref__c', code: 'unknown_field' }]))).not.toEqual([]);
  expect(fired(() => expect(patch({ Tier: 'gold' })?.body.details).toEqual([{ path: 'custom', code: 'unknown_field' }]))).not.toEqual([]);
  expect(fired(() => patch({ tier__c: 'gold' })), 'an unchanged key is "sent unchanged"').not.toEqual([]);
  expect(fired(() => patch({ renewal_date__c: null })), 'a null for a key with no value is "sent unchanged"').not.toEqual([]);
  expect(fired(() => patch({})), 'an empty patch').not.toEqual([]);
  // Read-only: the first 403 is legitimate (the screen could not know); a resend is not.
  expect(fired(() => expect(patch({ service_note__c: 'Call after 4pm' })?.status).toBe(403))).toEqual([]);
  expect(fired(() => patch({ service_note__c: 'Call after 4pm' })), 'a key resent after field_not_editable').not.toEqual([]);
  // A good patch passes, merges, and drops retired keys (D-L142).
  expect(fired(() => expect(patch({ tier__c: 'silver', vip__c: null, credit_limit__c: { amountMinor: '-1050', currency: 'NGN' } })).toBeUndefined())).toEqual([]);
  server.applyPatch('contact', 'r1', { tier__c: 'silver', vip__c: null });
  expect(server.stored('r1')).toEqual({ tier__c: 'silver', alternate_name__c: 'withheld' });

  // Creates carry values only.
  expect(fired(() => server.checkCreate('activity', 'p1', { outcome__c: null }, 'planted'))).not.toEqual([]);
  expect(fired(() => expect(server.checkCreate('activity', 'p1', { outcome__c: 'promise', follow_up__c: true }, 'planted')).toBeUndefined())).toEqual([]);

  // Filters.
  const filter = (query: string) => server.checkFilters('contact', new URLSearchParams(query), ['p1'], 'planted');
  expect(fired(() => expect(filter('custom[service_note__c]=x')?.body.details).toEqual([{ path: 'custom.service_note__c', code: 'filter_not_supported' }]))).not.toEqual([]);
  expect(fired(() => expect(filter('custom[credit_limit__c]=1')?.status).toBe(400))).not.toEqual([]);
  expect(fired(() => expect(filter('custom[tier__c]=bronze')?.status).toBe(400))).not.toEqual([]);
  expect(fired(() => expect(filter('custom[vip__c]=yes')?.status).toBe(400))).not.toEqual([]);
  expect(fired(() => expect(filter('custom[legacy_ref__c]=x')?.status).toBe(400))).not.toEqual([]);
  expect(fired(() => filter('custom[tier__c]=gold&customEmpty=tier__c')), 'a key both equal and empty').not.toEqual([]);
  // Withheld anywhere is the API's 400, not the screen's fault: it cannot always know.
  expect(fired(() => expect(filter('custom[risk_band__c]=high')?.body.details).toEqual([{ path: 'custom.risk_band__c', code: 'field_withheld' }]))).toEqual([]);
  expect(fired(() => expect(filter('custom[tier__c]=silver&customEmpty=vip__c')).toBeUndefined())).toEqual([]);
  expect(server.matches('contact', 'r1', 'p1', new URLSearchParams('custom[tier__c]=silver&customEmpty=vip__c'))).toBe(true);
  expect(server.matches('contact', 'r1', 'p1', new URLSearchParams('custom[tier__c]=gold'))).toBe(false);
  // A mock with no setup changes nothing on a row and refuses any custom value.
  const bare = new CustomFieldsServer(undefined, violations);
  expect(bare.decorate({ id: 'x', withheldFields: ['emails'] }, 'contact', 'x', 'p1')).toEqual({ id: 'x', withheldFields: ['emails'] });
  expect(fired(() => bare.checkPatch('contact', 'x', 'p1', { tier__c: 'gold' }, 'planted'))).not.toEqual([]);
  expect((bare.listAnswer(new URL('http://mock/api/v1/admin/custom-fields?object=deal')).body.items as unknown[]).length).toBe(0);
});

// ===========================================================================
// 1. Showing values on the records
// ===========================================================================

test('the contact record shows every active custom field, each in its slot and its format, and no retired one @p18-custom-values @p18-custom-values-contact', async ({ page }) => {
  const mock = await openContact(page, CONTACT_FULL.id, { customFields: contactSetup() });
  const root = CONTACT_SCREEN;
  await expect(slot(page, root, 'tier__c'), 'no [data-custom-field] slot: custom values are not drawn').toBeVisible();
  expect(mock.custom.definitionReads.some((url) => url.searchParams.get('object') === 'contact'), 'the record never read the contact definitions').toBe(true);
  expect((await drawnKeys(page, root)).sort(), 'one slot per ACTIVE definition: no more, no fewer').toEqual(activeKeys(CONTACT_FIELDS).sort());
  for (const [key, stored] of Object.entries(CONTACT_VALUES)) {
    if (key === 'alternate_name__c' || key === 'legacy_ref__c') continue;
    await expectShown(page, root, 'contact', key, stored);
  }
  await expectWithheldSlot(page, root, 'alternate_name__c');
  await expect(page.locator(`${root} [data-custom-field="legacy_ref__c"]`), 'a retired field is drawn').toHaveCount(0);
  expect(await visibleText(page.locator(root)), 'a retired field\'s label is drawn').not.toContain(fieldOf('contact', 'legacy_ref__c').label);
  expect(await visibleText(page.locator(root)), 'an api name is printed').not.toMatch(/\b[a-z][a-z0-9_]*__c\b/);
  await expectNoLeak(page, ALL_SENTINELS, 'the contact record');
});

test('a lead (a contact at a lead status) shows its custom values on its record @p18-custom-values @p18-custom-values-lead', async ({ page }) => {
  expect(['new', 'contacted'], 'the fixture is not at a lead status').toContain(String(CONTACT_CLAIMABLE.status));
  await openContact(page, CONTACT_CLAIMABLE.id, { customFields: contactSetup() });
  await expectShown(page, CONTACT_SCREEN, 'contact', 'tier__c', 'gold');
  await expectShown(page, CONTACT_SCREEN, 'contact', 'vip__c', false);
  await expectShown(page, CONTACT_SCREEN, 'contact', 'renewal_date__c', '2026-12-31');
  await expectEmptySlot(page, CONTACT_SCREEN, 'contact', 'credit_limit__c');
});

test('the account record shows its custom values in the field\'s currency (GHS), and the withheld key locked @p18-custom-values @p18-custom-values-account', async ({ page }) => {
  const mock = await openAccount(page, { customFields: accountSetup() });
  const root = ACCOUNT_SCREEN;
  await expect(slot(page, root, 'segment__c'), 'no [data-custom-field] slot on the account record').toBeVisible();
  expect(mock.custom.definitionReads.some((url) => url.searchParams.get('object') === 'account'), 'the record never read the account definitions').toBe(true);
  expect((await drawnKeys(page, root)).sort()).toEqual(activeKeys(ACCOUNT_FIELDS).sort());
  await expectShown(page, root, 'account', 'contract_value__c', ACCOUNT_VALUES.contract_value__c);
  await expectShown(page, root, 'account', 'key_account__c', true);
  await expectShown(page, root, 'account', 'review_date__c', ACCOUNT_VALUES.review_date__c);
  await expectShown(page, root, 'account', 'segment__c', ACCOUNT_VALUES.segment__c);
  await expectWithheldSlot(page, root, 'internal_rating__c');
  await expect(page.locator(`${root} [data-custom-field="old_code__c"]`)).toHaveCount(0);
  await expectNoLeak(page, ALL_SENTINELS, 'the account record');
});

test('the deal shows its custom values in the field\'s currency (ZAR), and the withheld key locked @p18-custom-values @p18-custom-values-deal', async ({ page }) => {
  const mock = await openDeal(page, { customFields: dealSetup() });
  const root = DEAL_SCREEN;
  await expect(slot(page, root, 'source_channel__c'), 'no [data-custom-field] slot on the deal').toBeVisible();
  expect(mock.custom.definitionReads.some((url) => url.searchParams.get('object') === 'deal'), 'the deal never read the deal definitions').toBe(true);
  expect((await drawnKeys(page, root)).sort()).toEqual(activeKeys(DEAL_FIELDS).sort());
  await expectShown(page, root, 'deal', 'margin__c', DEAL_VALUES.margin__c);
  await expectShown(page, root, 'deal', 'go_live__c', DEAL_VALUES.go_live__c);
  await expectShown(page, root, 'deal', 'partner_led__c', false);
  await expectShown(page, root, 'deal', 'source_channel__c', DEAL_VALUES.source_channel__c);
  await expectWithheldSlot(page, root, 'win_reason__c');
  await expect(page.locator(`${root} [data-custom-field="old_stage__c"]`)).toHaveCount(0);
  await expectNoLeak(page, ALL_SENTINELS, 'the deal');
});

test('values follow the caller\'s locale: French separators for the currency, the number and the date @p18-custom-values @p18-custom-values-locale', async ({ page }) => {
  await openContact(page, CONTACT_FULL.id, { customFields: contactSetup(), query: '?locale=fr' });
  expect(await pageLang(page), 'the page did not switch to French').toMatch(/^fr/);
  await expectShown(page, CONTACT_SCREEN, 'contact', 'credit_limit__c', CONTACT_VALUES.credit_limit__c);
  await expectShown(page, CONTACT_SCREEN, 'contact', 'satisfaction_score__c', CONTACT_VALUES.satisfaction_score__c);
  await expectShown(page, CONTACT_SCREEN, 'contact', 'renewal_date__c', CONTACT_VALUES.renewal_date__c);
  // A label is the tenant's, not the locale's: it is drawn as defined.
  await expectShown(page, CONTACT_SCREEN, 'contact', 'tier__c', CONTACT_VALUES.tier__c);
  const said = await visibleText(valueOf(slot(page, CONTACT_SCREEN, 'satisfaction_score__c')));
  expect(said, 'the number kept the English decimal point').toContain(',');
});

test('an 18-digit amount and an 18-digit number keep every digit: never a float @p18-custom-values @p18-custom-values-precision', async ({ page }) => {
  const big = { amountMinor: '900719925474099312', currency: 'NGN' };
  const negative = { amountMinor: '-123456789012345678', currency: 'NGN' };
  await openContact(page, CONTACT_FULL.id, {
    customFields: contactSetup({
      values: {
        [CONTACT_FULL.id]: { credit_limit__c: big, satisfaction_score__c: '123456789012345.678' },
        [CONTACT_LOCKED.id]: { credit_limit__c: negative },
      },
    }),
  });
  await expectShown(page, CONTACT_SCREEN, 'contact', 'credit_limit__c', big);
  await expectShown(page, CONTACT_SCREEN, 'contact', 'satisfaction_score__c', '123456789012345.678');
  await page.goto(`${recordsUrl()}/contacts/${CONTACT_LOCKED.id}`);
  await expect(page.locator(CONTACT_SCREEN)).toHaveAttribute('data-record-state', 'ready');
  await expectShown(page, CONTACT_SCREEN, 'contact', 'credit_limit__c', negative);
});

test.describe('a browser west of UTC', () => {
  test.use({ timezoneId: 'Atlantic/Cape_Verde' });

  test('a date is a calendar date: the same day in Cape Verde (UTC-1), never the day before @p18-custom-values @p18-custom-values-calendar-date', async ({ page }) => {
    await openContact(page, CONTACT_FULL.id, { customFields: contactSetup() });
    expect(await page.evaluate(() => new Date('2027-03-01').getDate()), 'the browser is not west of UTC: the check would prove nothing').toBe(28);
    await expectShown(page, CONTACT_SCREEN, 'contact', 'renewal_date__c', '2027-03-01');
    const sheet = await openSheet(page, CONTACT_SCREEN, 'edit-contact', 'contact-sheet');
    await expect(customInput(sheet, 'renewal_date__c'), 'the date input is prefilled with another day').toHaveValue('2027-03-01');
  });
});

test('a withheld key is never drawn: the slot is locked, per record and programme, and its value is nowhere @p18-custom-values @p18-custom-values-withheld', async ({ page }) => {
  await openContact(page, CONTACT_FULL.id, { role: 'writer', customFields: contactSetup() });
  await expectWithheldSlot(page, CONTACT_SCREEN, 'alternate_name__c');
  await expectShown(page, CONTACT_SCREEN, 'contact', 'vip__c', true);
  const sheet = await openSheet(page, CONTACT_SCREEN, 'edit-contact', 'contact-sheet');
  expect(await inputKeys(sheet), 'the form offers an input for a key the caller cannot read').not.toContain('alternate_name__c');
  await page.keyboard.press('Escape');
  await expectNoLeak(page, ALL_SENTINELS, 'programme one');
  // Programme two withholds vip__c and reads alternate_name__c: decided per record, never cached per key.
  await page.goto(`${recordsUrl()}/contacts/${CONTACT_LOCKED.id}`);
  await expect(page.locator(CONTACT_SCREEN)).toHaveAttribute('data-record-state', 'ready');
  await expectWithheldSlot(page, CONTACT_SCREEN, 'vip__c');
  await expectShown(page, CONTACT_SCREEN, 'contact', 'alternate_name__c', 'Chidi Alternate');
  await expectNoLeak(page, ALL_SENTINELS, 'programme two');
});

test('a defined key with no value is empty, never locked; a withheld key with no value is still locked (D-L141) @p18-custom-values @p18-custom-values-empty', async ({ page }) => {
  await openContact(page, CONTACT_NULLS.id, { customFields: contactSetup() });
  await expectShown(page, CONTACT_SCREEN, 'contact', 'tier__c', 'gold');
  for (const key of ['credit_limit__c', 'renewal_date__c', 'risk_band__c', 'satisfaction_score__c', 'service_note__c', 'vip__c']) {
    await expectEmptySlot(page, CONTACT_SCREEN, 'contact', key);
  }
  await expectWithheldSlot(page, CONTACT_SCREEN, 'alternate_name__c');
});

test('retired fields are never shown: active definitions only, and a key the screen has no definition for is never drawn @p18-custom-values @p18-custom-values-retired', async ({ page }) => {
  const mock = await openContact(page, CONTACT_FULL.id, { customFields: contactSetup({ createdLate: ['service_note__c'] }) });
  await expect(slot(page, CONTACT_SCREEN, 'tier__c')).toBeVisible();
  expect(mock.custom.definitionReads.length, 'no definitions read').toBeGreaterThan(0);
  for (const url of mock.custom.definitionReads) {
    expect(url.searchParams.get('includeRetired') ?? 'false', 'a record screen asked for retired definitions').toBe('false');
  }
  await expect(page.locator(`${CONTACT_SCREEN} [data-custom-field="legacy_ref__c"]`)).toHaveCount(0);
  // service_note__c is on the record but not in the definitions the screen read: no label, no type, no slot.
  await expect(page.locator(`${CONTACT_SCREEN} [data-custom-field="service_note__c"]`), 'a key with no definition got a slot').toHaveCount(0);
  const text = await visibleText(page.locator(CONTACT_SCREEN));
  expect(text, 'a value with no definition was drawn raw').not.toContain(CONTACT_VALUES.service_note__c);
  expect(text, 'an api name is printed').not.toMatch(/__c\b/);
});

test('when the definitions cannot be read the record still loads, and no custom value is drawn raw @p18-custom-values @p18-custom-values-definitions-failed', async ({ page }) => {
  const mock = await openContact(page, CONTACT_FULL.id, { customFields: contactSetup({ definitionsFailure: true }) });
  await expect(shown(page.locator(`${CONTACT_SCREEN} h1`)).first()).toContainText(CONTACT_FULL.displayName);
  await expect(page.getByTestId('record-unavailable'), 'a failed definitions read took the whole record down').toHaveCount(0);
  await expect.poll(() => mock.custom.definitionReads.length, { message: 'the record never asked for its definitions' }).toBeGreaterThan(0);
  const text = await visibleText(page.locator(CONTACT_SCREEN));
  for (const raw of ['platinum', CONTACT_VALUES.service_note__c, '125000050', '2027-03-01']) {
    expect(text, `a value was drawn without its definition: ${raw}`).not.toContain(raw);
  }
  expect(text, 'an api name is printed').not.toMatch(/__c\b/);
  await expect(page.locator(`${CONTACT_SCREEN} [data-custom-value]`), 'a value drawn with no definition').toHaveCount(0);
});

test('markup in a text value is drawn as text, never parsed @p18-custom-values @p18-custom-values-markup', async ({ page }) => {
  const hostile = '<img src=x onerror="window.__kasuwaXss=9">Gold <b>member</b>';
  await openContact(page, CONTACT_FULL.id, { customFields: contactSetup({ values: { [CONTACT_FULL.id]: { service_note__c: hostile } } }) });
  const where = slot(page, CONTACT_SCREEN, 'service_note__c');
  await expect(valueOf(where)).toHaveText(fold(hostile));
  await expect(where.locator('img, b')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __kasuwaXss?: number }).__kasuwaXss)).toBeUndefined();
});

// ===========================================================================
// 2. Editing
// ===========================================================================

test('an edit sends a per-key merge: only the changed keys, a picklist value, a currency in minor units of the field\'s currency @p18-custom-values @p18-custom-values-edit', async ({ page }) => {
  const mock = await openContact(page, CONTACT_FULL.id, { role: 'writer', customFields: contactSetup() });
  const sheet = await openSheet(page, CONTACT_SCREEN, 'edit-contact', 'contact-sheet');
  const editable = activeKeys(CONTACT_FIELDS).filter((key) => key !== 'alternate_name__c');
  expect((await inputKeys(sheet)).sort(), 'one input per active, readable key').toEqual(editable.sort());
  await expectInputShapes(sheet, 'contact', editable);
  await expect(customInput(sheet, 'tier__c')).toHaveValue('platinum');
  await expect(customInput(sheet, 'vip__c')).toHaveValue('true');
  expect(digits(await customInput(sheet, 'credit_limit__c').inputValue()), 'the amount is not prefilled in major units').toBe('125000050');
  await setCustom(sheet, 'contact', 'tier__c', 'gold');
  await setCustom(sheet, 'contact', 'credit_limit__c', '2500000.75');
  const sent = page.waitForRequest((request) => isUpdateContact(request, CONTACT_FULL.id));
  await shown(sheet.locator('[data-action="save-contact"]')).first().click();
  const body = json((await sent).postDataJSON());
  expect(Object.keys(body).sort(), 'the save carried more than version and custom').toEqual(['custom', 'version']);
  expect(body.version).toBe(CONTACT_FULL.version);
  expect(body.custom, 'not a per-key merge of exactly what changed').toEqual({ tier__c: 'gold', credit_limit__c: { amountMinor: '250000075', currency: 'NGN' } });
  await expect(shown(page.getByTestId('contact-sheet'))).toHaveCount(0);
  await expect.poll(() => visibleText(valueOf(slot(page, CONTACT_SCREEN, 'tier__c')))).toBe('Gold');
  await expectShown(page, CONTACT_SCREEN, 'contact', 'credit_limit__c', { amountMinor: '250000075', currency: 'NGN' });
  expect(mock.custom.writes, 'the save was sent more than once').toHaveLength(1);
  await expectNoLeak(page, ALL_SENTINELS, 'after the save');
});

test('each type is sent in its encoding: a canonical number, a calendar date, a JSON boolean, a line of text @p18-custom-values @p18-custom-values-edit-types', async ({ page }) => {
  await openContact(page, CONTACT_FULL.id, { role: 'writer', customFields: contactSetup() });
  const sheet = await openSheet(page, CONTACT_SCREEN, 'edit-contact', 'contact-sheet');
  await setCustom(sheet, 'contact', 'satisfaction_score__c', '12.50');
  await setCustom(sheet, 'contact', 'renewal_date__c', '2027-04-15');
  await setCustom(sheet, 'contact', 'vip__c', 'false');
  await setCustom(sheet, 'contact', 'service_note__c', 'Calls after 4pm');
  await setCustom(sheet, 'contact', 'risk_band__c', 'high');
  const sent = page.waitForRequest((request) => isUpdateContact(request, CONTACT_FULL.id));
  await shown(sheet.locator('[data-action="save-contact"]')).first().click();
  const body = json((await sent).postDataJSON());
  expect(body.custom).toEqual({
    satisfaction_score__c: '12.5',
    renewal_date__c: '2027-04-15',
    vip__c: false,
    service_note__c: 'Calls after 4pm',
    risk_band__c: 'high',
  });
  await expect(shown(page.getByTestId('contact-sheet'))).toHaveCount(0);
  await expectShown(page, CONTACT_SCREEN, 'contact', 'vip__c', false);
  await expectShown(page, CONTACT_SCREEN, 'contact', 'risk_band__c', 'high');
});

test('clearing a value sends null for that key alone, and the slot is then empty @p18-custom-values @p18-custom-values-clear', async ({ page }) => {
  await openContact(page, CONTACT_FULL.id, { role: 'writer', customFields: contactSetup() });
  const sheet = await openSheet(page, CONTACT_SCREEN, 'edit-contact', 'contact-sheet');
  await setCustom(sheet, 'contact', 'renewal_date__c', '');
  await setCustom(sheet, 'contact', 'vip__c', '');
  await setCustom(sheet, 'contact', 'credit_limit__c', '');
  await setCustom(sheet, 'contact', 'tier__c', '');
  const sent = page.waitForRequest((request) => isUpdateContact(request, CONTACT_FULL.id));
  await shown(sheet.locator('[data-action="save-contact"]')).first().click();
  const body = json((await sent).postDataJSON());
  expect(body.custom, 'clearing is null per key, nothing else').toEqual({ renewal_date__c: null, vip__c: null, credit_limit__c: null, tier__c: null });
  await expect(shown(page.getByTestId('contact-sheet'))).toHaveCount(0);
  for (const key of ['renewal_date__c', 'vip__c', 'credit_limit__c', 'tier__c']) {
    await expectEmptySlot(page, CONTACT_SCREEN, 'contact', key);
  }
});

for (const code of ['invalid_value', 'custom_too_large', 'unknown_field'] as const) {
  test(`a ${code} refusal is a translated message on the form, never the raw code @p18-custom-values @p18-custom-values-errors`, async ({ page }) => {
    const mock = await openContact(page, CONTACT_FULL.id, { role: 'writer', customFields: contactSetup({ refuse: { code, key: 'service_note__c' } }) });
    const sheet = await openSheet(page, CONTACT_SCREEN, 'edit-contact', 'contact-sheet');
    await setCustom(sheet, 'contact', 'service_note__c', 'A new note');
    const answered = page.waitForResponse((response) => isUpdateContact(response.request(), CONTACT_FULL.id));
    await shown(sheet.locator('[data-action="save-contact"]')).first().click();
    expect((await answered).status()).toBe(400);
    const alert = shown(sheet.getByRole('alert')).first();
    await expect(alert, `a ${code} refusal drew no role=alert on the form`).toBeVisible();
    await expectSaysOneOf(alert, errorLabels(code), `the ${code} message`);
    expect(await visibleText(alert), 'the raw code is shown').not.toContain(code);
    await expect(sheet, 'a refused save closed the form').toBeVisible();
    expect(mock.custom.writes).toHaveLength(1);
  });
}

test('a field_not_editable refusal is translated (en-XA proves it is the screen\'s copy) and the key becomes read-only, never sent again @p18-custom-values @p18-custom-values-errors @p18-custom-values-read-only', async ({ page }) => {
  const mock = await openContact(page, CONTACT_FULL.id, {
    role: 'writer',
    query: '?locale=en-XA',
    customFields: contactSetup({ refuse: { code: 'field_not_editable', key: 'vip__c' } }),
  });
  const sheet = await openSheet(page, CONTACT_SCREEN, 'edit-contact', 'contact-sheet');
  await setCustom(sheet, 'contact', 'vip__c', 'false');
  const answered = page.waitForResponse((response) => isUpdateContact(response.request(), CONTACT_FULL.id));
  await shown(sheet.locator('[data-action="save-contact"]')).first().click();
  expect((await answered).status()).toBe(403);
  const alert = shown(sheet.getByRole('alert')).first();
  await expect(alert, 'the 403 drew no role=alert on the form').toBeVisible();
  expect(await visibleText(alert), 'the field_not_editable message is not the screen\'s own translated copy').toMatch(PSEUDO);
  expect(await visibleText(alert)).not.toContain('field_not_editable');
  // The key is now read-only: disabled, read-only or gone. Never sent again.
  const vip = sheet.locator('[data-custom-input="vip__c"]');
  if ((await vip.count()) > 0) {
    expect(await isDisabled(vip.first()), 'the refused key is still editable').toBe(true);
  }
  await setCustom(sheet, 'contact', 'tier__c', 'gold');
  const retried = page.waitForRequest((request) => isUpdateContact(request, CONTACT_FULL.id) && JSON.stringify(request.postDataJSON()).includes('tier__c'));
  await shown(sheet.locator('[data-action="save-contact"]')).first().click();
  const body = json((await retried).postDataJSON());
  expect(body.custom, 'the read-only key was sent again').toEqual({ tier__c: 'gold' });
  expect(mock.custom.writes).toHaveLength(2);
});

test('the account record edits its custom values with a per-key merge in GHS minor units @p18-custom-values @p18-custom-values-edit-account', async ({ page }) => {
  await openAccount(page, { role: 'admin', customFields: accountSetup() });
  const sheet = await openSheet(page, ACCOUNT_SCREEN, 'edit-account', 'account-sheet');
  const editable = activeKeys(ACCOUNT_FIELDS).filter((key) => key !== 'internal_rating__c');
  expect((await inputKeys(sheet)).sort(), 'one input per active, readable key; none for the withheld one').toEqual(editable.sort());
  await expectInputShapes(sheet, 'account', editable);
  await setCustom(sheet, 'account', 'segment__c', 'telco');
  await setCustom(sheet, 'account', 'contract_value__c', '1000');
  await setCustom(sheet, 'account', 'review_date__c', '');
  const sent = page.waitForRequest((request) => isRecordUpdateAccount(request, ACCOUNT_FULL.id));
  await shown(sheet.locator('[data-action="save-account"]')).first().click();
  const body = json((await sent).postDataJSON());
  expect(Object.keys(body).sort()).toEqual(['custom', 'version']);
  expect(body.custom).toEqual({ segment__c: 'telco', contract_value__c: { amountMinor: '100000', currency: 'GHS' }, review_date__c: null });
  await expect(shown(page.getByTestId('account-sheet'))).toHaveCount(0);
  await expectShown(page, ACCOUNT_SCREEN, 'account', 'segment__c', 'telco');
  await expectNoLeak(page, ALL_SENTINELS, 'after the account save');
});

test('the deal edits its custom values with a per-key merge in ZAR minor units @p18-custom-values @p18-custom-values-edit-deal', async ({ page }) => {
  await openDeal(page, { customFields: dealSetup() });
  const sheet = await openSheet(page, DEAL_SCREEN, 'edit-deal', 'deal-sheet');
  const editable = activeKeys(DEAL_FIELDS).filter((key) => key !== 'win_reason__c');
  expect((await inputKeys(sheet)).sort(), 'one input per active, readable key; none for the withheld one').toEqual(editable.sort());
  await expectInputShapes(sheet, 'deal', editable);
  await setCustom(sheet, 'deal', 'partner_led__c', 'true');
  await setCustom(sheet, 'deal', 'margin__c', '-12.5');
  const sent = page.waitForRequest((request) => isUpdateDeal(request, X_FULL.id));
  await shown(sheet.locator('[data-action="save-deal"]')).first().click();
  const body = json((await sent).postDataJSON());
  expect(Object.keys(body).sort()).toEqual(['custom', 'version']);
  expect(body.custom).toEqual({ partner_led__c: true, margin__c: { amountMinor: '-1250', currency: 'ZAR' } });
  await expect(shown(page.getByTestId('deal-sheet'))).toHaveCount(0);
  await expectShown(page, DEAL_SCREEN, 'deal', 'partner_led__c', true);
  await expectNoLeak(page, ALL_SENTINELS, 'after the deal save');
});

// ===========================================================================
// 3. The activity forms (create: values only)
// ===========================================================================

test('the contact record\'s activity form offers the activity\'s custom fields and creates with filled values only @p18-custom-values @p18-custom-values-activity-form', async ({ page }) => {
  await openContact(page, CONTACT_FULL.id, { customFields: contactSetup() });
  const form = await openLog(page, 'note');
  const keys = activeKeys(ACTIVITY_FIELDS);
  expect((await inputKeys(form)).sort(), 'one input per active activity field, none retired').toEqual(keys.sort());
  await expectInputShapes(form, 'activity', keys);
  await form.locator('[data-field-input="body"]').first().fill('Promised to pay on Friday');
  await setCustom(form, 'activity', 'outcome__c', 'promise');
  await setCustom(form, 'activity', 'promised_amount__c', '15000');
  const sent = page.waitForRequest(isContactCreateActivity);
  await shown(form.locator('[data-action="save-activity"]')).first().click();
  const body = json((await sent).postDataJSON());
  expect(body.custom, 'a create carries the filled values only: no null, no empty key').toEqual({
    outcome__c: 'promise',
    promised_amount__c: { amountMinor: '1500000', currency: 'NGN' },
  });
});

test('the P07 composer offers the activity\'s custom fields, creates with values only, and translates a field_not_editable refusal @p18-custom-values @p18-custom-values-activity-compose', async ({ page }) => {
  await page.clock.setFixedTime(new Date(ACTIVITIES_NOW));
  watch(await installActivitiesMock(page, { customFields: { refuse: { code: 'field_not_editable', key: 'reference__c' } } }));
  const response = await page.goto(`${recordsUrl()}/activities`);
  expect(response?.status()).toBe(200);
  await shown(page.locator(`${ACTIVITIES_SCREEN} [data-action="compose"]`)).first().click();
  const composer = shown(page.getByTestId('activity-composer')).first();
  await expect(composer).toBeVisible();
  await shown(composer.locator('[data-activity-type="task"]')).first().click();
  const keys = activeKeys(ACTIVITY_FIELDS);
  expect((await inputKeys(composer)).sort(), 'one input per active activity field').toEqual(keys.sort());
  await expectInputShapes(composer, 'activity', keys);
  await composer.locator('[data-field-input="subject"]').first().fill('Call back about the arrears');
  await composer.locator('[data-field-input="target"]').first().fill('Adaeze');
  await shown(page.locator(`[data-target-option="${PICK_CONTACT.id}"]`)).first().click();
  await composer.locator('[data-field-input="dueAt"]').first().fill('2026-10-01T09:30');
  await setCustom(composer, 'activity', 'outcome__c', 'callback');
  await setCustom(composer, 'activity', 'follow_up__c', 'true');
  await setCustom(composer, 'activity', 'promise_date__c', '2026-10-05');
  await setCustom(composer, 'activity', 'reference__c', 'REF-2210');
  const sent = page.waitForRequest(isComposerCreateActivity);
  await shown(composer.locator('[data-action="save-activity"]')).first().click();
  const body = json((await sent).postDataJSON());
  expect(body.custom).toEqual({ outcome__c: 'callback', follow_up__c: true, promise_date__c: '2026-10-05', reference__c: 'REF-2210' });
  const alert = shown(composer.getByRole('alert')).first();
  await expect(alert, 'the 403 drew no role=alert in the composer').toBeVisible();
  await expectSaysOneOf(alert, errorLabels('field_not_editable'), 'the field_not_editable message');
});

// ===========================================================================
// 4. The list filters
// ===========================================================================

test('the contacts list offers picklist and boolean filters only, sends custom[key] and customEmpty, and never sorts on a custom field @p18-custom-values @p18-custom-values-filter-contacts', async ({ page }) => {
  const mock = watch(
    await installRecordsMock(page, {
      customFields: {
        values: {
          [LIST_CONTACT.id]: { tier__c: 'gold', vip__c: true },
          [LIST_ROW_NULLS.id]: { tier__c: 'silver' },
          [LIST_ROW_PAGE_TWO.id]: { tier__c: 'gold' },
        },
      },
    }),
  );
  await page.goto(`${recordsUrl()}/contacts`);
  await expect(shown(page.locator(`${CONTACTS_SCREEN} [data-row-id="${LIST_ROW_NULLS.id}"]`)).first()).toBeVisible();
  await expect.poll(() => offeredCustomFilters(page, CONTACTS_SCREEN), { message: 'the contacts list offers no custom filter' }).toEqual(filterable(CONTACT_FIELDS));
  await expectFilterOptions(page, CONTACTS_SCREEN, 'contact', 'tier__c');
  await expectFilterOptions(page, CONTACTS_SCREEN, 'contact', 'vip__c');
  const equal = page.waitForRequest((request) => isListContacts(request) && new URL(request.url()).searchParams.get('custom[tier__c]') === 'gold');
  await chooseCustomFilter(page, CONTACTS_SCREEN, 'tier__c', 'gold');
  const params = new URL((await equal).url()).searchParams;
  expect(params.getAll('customEmpty')).toEqual([]);
  await expect(shown(page.locator(`${CONTACTS_SCREEN} [data-row-id="${LIST_CONTACT.id}"]`)).first()).toBeVisible();
  await expect(page.locator(`${CONTACTS_SCREEN} [data-row-id="${LIST_ROW_NULLS.id}"]`).filter({ visible: true })).toHaveCount(0);
  const empty = page.waitForRequest((request) => isListContacts(request) && new URL(request.url()).searchParams.getAll('customEmpty').includes('vip__c'));
  await chooseCustomFilter(page, CONTACTS_SCREEN, 'vip__c', 'is-empty');
  const emptyParams = new URL((await empty).url()).searchParams;
  expect(emptyParams.get('custom[vip__c]'), '"is empty" also sent an equality').toBeNull();
  await expectNoCustomSort(page, CONTACTS_SCREEN);
  expect(mock.custom.definitionReads.some((url) => url.searchParams.get('object') === 'contact')).toBe(true);
});

test('the leads list filters on a picklist with custom[key] @p18-custom-values @p18-custom-values-filter-leads', async ({ page }) => {
  watch(await installLeadsMock(page, { customFields: { values: { [LEAD_NEW.id]: { risk_band__c: 'high' }, [LEAD_EXAMPLE.id]: { risk_band__c: 'low' } } } }));
  await page.goto(`${recordsUrl()}/leads`);
  await expect(shown(page.locator(`${LEADS_SCREEN} [data-row-id="${LEAD_EXAMPLE.id}"]`)).first()).toBeVisible();
  await expect.poll(() => offeredCustomFilters(page, LEADS_SCREEN), { message: 'the leads list offers no custom filter' }).toEqual(filterable(CONTACT_FIELDS));
  const sent = page.waitForRequest((request) => isListLeads(request) && new URL(request.url()).searchParams.get('custom[risk_band__c]') === 'high');
  await chooseCustomFilter(page, LEADS_SCREEN, 'risk_band__c', 'high');
  await sent;
  await expect(shown(page.locator(`${LEADS_SCREEN} [data-row-id="${LEAD_NEW.id}"]`)).first()).toBeVisible();
  await expect(page.locator(`${LEADS_SCREEN} [data-row-id="${LEAD_EXAMPLE.id}"]`).filter({ visible: true })).toHaveCount(0);
  await expectNoCustomSort(page, LEADS_SCREEN);
});

test('the accounts list filters on a picklist and on "is empty" for a boolean @p18-custom-values @p18-custom-values-filter-accounts', async ({ page }) => {
  watch(
    await installAccountsMock(page, {
      customFields: { values: { [LIST_ACCOUNT.id]: { segment__c: 'retail', key_account__c: true }, [LIST_ACCOUNT_NULLS.id]: { segment__c: 'telco' } } },
    }),
  );
  await page.goto(`${recordsUrl()}/accounts`);
  await expect(shown(page.locator(`${ACCOUNTS_SCREEN} [data-row-id="${LIST_ACCOUNT_NULLS.id}"]`)).first()).toBeVisible();
  await expect.poll(() => offeredCustomFilters(page, ACCOUNTS_SCREEN), { message: 'the accounts list offers no custom filter' }).toEqual(filterable(ACCOUNT_FIELDS));
  await expectFilterOptions(page, ACCOUNTS_SCREEN, 'account', 'segment__c');
  const equal = page.waitForRequest((request) => isListAccounts(request) && new URL(request.url()).searchParams.get('custom[segment__c]') === 'retail');
  await chooseCustomFilter(page, ACCOUNTS_SCREEN, 'segment__c', 'retail');
  await equal;
  await expect(shown(page.locator(`${ACCOUNTS_SCREEN} [data-row-id="${LIST_ACCOUNT.id}"]`)).first()).toBeVisible();
  await expect(page.locator(`${ACCOUNTS_SCREEN} [data-row-id="${LIST_ACCOUNT_NULLS.id}"]`).filter({ visible: true })).toHaveCount(0);
  const empty = page.waitForRequest((request) => isListAccounts(request) && new URL(request.url()).searchParams.getAll('customEmpty').includes('key_account__c'));
  await chooseCustomFilter(page, ACCOUNTS_SCREEN, 'key_account__c', 'is-empty');
  await empty;
  await expectNoCustomSort(page, ACCOUNTS_SCREEN);
});

test('the pipeline\'s list view filters deals with custom[key]; the board read never carries a custom filter @p18-custom-values @p18-custom-values-filter-deals', async ({ page }) => {
  const openStages = new Set(PIPELINE_ONE.stages.filter((stage) => stage.kind === 'open').map((stage) => stage.id));
  const [tender, referral] = baseDeals().filter((deal) => deal.pipelineId === PIPELINE_ONE.id && openStages.has(deal.stageId));
  expect(tender !== undefined && referral !== undefined, 'the pipeline mock has fewer than two open deals').toBe(true);
  await page.clock.setFixedTime(new Date(PIPELINE_NOW));
  const mock = watch(
    await installPipelineMock(page, {
      customFields: { values: { [tender?.id ?? '']: { source_channel__c: 'tender' }, [referral?.id ?? '']: { source_channel__c: 'referral' } } },
    }),
  );
  await page.goto(`${recordsUrl()}/pipelines/${PIPELINE_ONE.id}`);
  await expect(page.locator(PIPELINE_SCREEN)).toBeVisible();
  const listed = page.waitForRequest(isListDeals);
  await shown(page.locator(`${PIPELINE_SCREEN} [data-view-option="list"]`)).first().click();
  await listed;
  await expect(page.locator(PIPELINE_SCREEN)).toHaveAttribute('data-view', 'list');
  await expect.poll(() => offeredCustomFilters(page, PIPELINE_SCREEN), { message: 'the deals list offers no custom filter' }).toEqual(filterable(DEAL_FIELDS));
  await expectFilterOptions(page, PIPELINE_SCREEN, 'deal', 'source_channel__c');
  const sent = page.waitForRequest((request) => isListDeals(request) && new URL(request.url()).searchParams.get('custom[source_channel__c]') === 'tender');
  await chooseCustomFilter(page, PIPELINE_SCREEN, 'source_channel__c', 'tender');
  await sent;
  await expect(shown(page.locator(`${PIPELINE_SCREEN} [data-deal-row="${tender?.id ?? ''}"]`)).first()).toBeVisible();
  await expect(page.locator(`${PIPELINE_SCREEN} [data-deal-row="${referral?.id ?? ''}"]`).filter({ visible: true })).toHaveCount(0);
  await expectNoCustomSort(page, PIPELINE_SCREEN);
  // Back to the board: its read declares no custom filter (the mock counts one as a violation).
  await shown(page.locator(`${PIPELINE_SCREEN} [data-view-option="board"]`)).first().click();
  await expect(page.locator(PIPELINE_SCREEN)).toHaveAttribute('data-view', 'board');
  expect(mock.boardReads.filter((url) => [...url.searchParams.keys()].some((name) => name.startsWith('custom'))).map(String)).toEqual([]);
});

test('a filter on a key withheld in a programme the caller reaches is answered field_withheld, drawn as a translated message @p18-custom-values @p18-custom-values-filter-withheld', async ({ page }) => {
  watch(
    await installRecordsMock(page, {
      customFields: { values: { [LIST_CONTACT.id]: { risk_band__c: 'high' } }, withheld: { contact: { [LIST_OTHER_PROGRAMME]: ['risk_band__c'] } } },
    }),
  );
  await page.goto(`${recordsUrl()}/contacts`);
  await expect(shown(page.locator(`${CONTACTS_SCREEN} [data-row-id="${LIST_CONTACT.id}"]`)).first()).toBeVisible();
  await expect.poll(() => offeredCustomFilters(page, CONTACTS_SCREEN)).toContain('risk_band__c');
  const answered = page.waitForResponse((response) => isListContacts(response.request()) && new URL(response.url()).searchParams.has('custom[risk_band__c]'));
  await chooseCustomFilter(page, CONTACTS_SCREEN, 'risk_band__c', 'high');
  expect((await answered).status()).toBe(400);
  const alert = shown(page.locator(`${CONTACTS_SCREEN} [role="alert"]`)).first();
  await expect(alert, 'field_withheld drew no role=alert on the list').toBeVisible();
  await expectSaysOneOf(alert, errorLabels('field_withheld'), 'the field_withheld message');
  expect(await visibleText(alert), 'the generic validation message instead of field_withheld').not.toBe(fold(EN['records.error.validation_failed'] ?? ''));
});

// ===========================================================================
// 5. Accessibility, 360 px and en-XA
// ===========================================================================

test('the record with custom values and its edit form are axe-clean @p18-custom-values @p18-custom-values-axe', async ({ page }) => {
  await openContact(page, CONTACT_FULL.id, { role: 'writer', customFields: contactSetup() });
  await expect(slot(page, CONTACT_SCREEN, 'tier__c')).toBeVisible();
  await expectNoSeriousAxe(page, 'the contact record with custom values');
  await openSheet(page, CONTACT_SCREEN, 'edit-contact', 'contact-sheet');
  await expectNoSeriousAxe(page, 'the edit form with custom inputs');
  // Every custom input has an accessible name.
  const unnamed = await page.locator('[data-testid="contact-sheet"] [data-custom-input]').evaluateAll((elements) =>
    elements
      .filter((element) => {
        const labelled = element.getAttribute('aria-label') ?? element.getAttribute('aria-labelledby') ?? '';
        const id = element.getAttribute('id');
        const forLabel = id === null ? null : document.querySelector(`label[for="${id}"]`);
        return labelled === '' && forLabel === null && element.closest('label') === null;
      })
      .map((element) => element.getAttribute('data-custom-input')),
  );
  expect(unnamed, 'custom inputs with no accessible name').toEqual([]);
});

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('the record, its custom values and the edit form fit 360 px with no sideways scroll, axe-clean @p18-custom-values @p18-custom-values-mobile', async ({ page }) => {
    await openContact(page, CONTACT_FULL.id, { role: 'writer', customFields: contactSetup() });
    await expect(slot(page, CONTACT_SCREEN, 'credit_limit__c')).toBeVisible();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow(), 'the record scrolls sideways at 360 px').toBeLessThanOrEqual(0);
    await expectNoSeriousAxe(page, 'the record at 360 px');
    const sheet = await openSheet(page, CONTACT_SCREEN, 'edit-contact', 'contact-sheet');
    await expect(customInput(sheet, 'tier__c')).toBeVisible();
    expect(await overflow(), 'the edit form scrolls sideways at 360 px').toBeLessThanOrEqual(0);
    await expectNoSeriousAxe(page, 'the edit form at 360 px');
  });
});

test('locale=en-XA renders every custom-field string as pseudo text; labels and values are record data @p18-custom-values @p18-custom-values-pseudo', async ({ page }) => {
  const setup = contactSetup();
  await openContact(page, CONTACT_FULL.id, { role: 'writer', customFields: setup, query: '?locale=en-XA' });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  await expect(slot(page, CONTACT_SCREEN, 'tier__c')).toBeVisible();
  const served = `${contactServedData()}\n${servedCustomData(setup)}`;
  const walk = async (rootSelector: string) =>
    page
      .locator(rootSelector)
      .first()
      .evaluate((root, servedJson) => {
        const pseudo = (text: string) => /[·[\]äëïöüÄËÏÖÜ]/.test(text);
        const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length >= 2;
        const onlyDigits = (text: string) => text.replace(/\D/g, '');
        const recordish = (text: string) =>
          servedJson.includes(text) || (onlyDigits(text).length >= 7 && onlyDigits(servedJson).includes(onlyDigits(text)));
        const skipped = (element: Element | null) =>
          element === null || element.closest('[aria-hidden="true"], [data-testid^="language-"], script, style, noscript, time') !== null;
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
  const record = await walk('[data-shell="crm"]');
  expect(record.english, 'strings on the record that did not come through i18n').toEqual([]);
  expect(record.forged, 'UI copy marked data-record-text that is not served record data').toEqual([]);
  expect(record.pseudoCount).toBeGreaterThanOrEqual(10);
  // The boolean is copy, not data: pseudo text.
  expect(await visibleText(valueOf(slot(page, CONTACT_SCREEN, 'vip__c')))).toMatch(PSEUDO);
  await expect(slot(page, CONTACT_SCREEN, 'alternate_name__c')).toHaveAttribute('data-locked', 'true');
  expect(await visibleText(slot(page, CONTACT_SCREEN, 'alternate_name__c'))).toMatch(PSEUDO);
  await openSheet(page, CONTACT_SCREEN, 'edit-contact', 'contact-sheet');
  const form = await walk('[data-testid="contact-sheet"]');
  expect(form.english, 'strings on the edit form that did not come through i18n').toEqual([]);
  expect(form.forged).toEqual([]);
  const options = await page.locator('[data-testid="contact-sheet"] [data-custom-input="vip__c"] option').evaluateAll((elements) =>
    elements.map((element) => (element.textContent ?? '').trim()).filter((text) => text !== ''),
  );
  expect(options.length, 'the boolean select offers nothing').toBeGreaterThan(0);
  for (const option of options) expect(option, 'a boolean option is not translated').toMatch(PSEUDO);
  expect(UUID.test(await visibleText(page.locator(CONTACT_SCREEN))), 'an id is printed').toBe(false);
});
