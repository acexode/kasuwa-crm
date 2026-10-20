import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TENANT_A } from '@kasuwa/db';
import { stack, type StackUrls } from './support/stack';
import { assertWithinByteBudget, measurePageLoad } from './support/metrics';
import { servedBuildId } from './support/critical-path';
import {
  BISI,
  BUCKETS,
  BUSY_WEEK_LENGTH,
  EMEKA,
  HOSTILE_ACCOUNT_ID,
  HOSTILE_CONTACT_ID,
  HOSTILE_SUBJECT,
  LONG_UPCOMING_LENGTH,
  MAX_WINDOW_MS,
  ME,
  M_LATE,
  M_OCT,
  M_PLANTED,
  M_PREV,
  M_QBR,
  M_RESCHED,
  M_SEPT,
  NEW_ACTIVITY_IDS,
  NOW,
  PICK_ACCOUNT,
  PICK_CONTACT,
  PROGRAMME_ONE,
  T_DONE,
  T_DONE_LOCKED,
  T_EMEKA,
  T_HOSTILE,
  T_HOSTILE_LINKS,
  T_KWARA,
  T_LATE_TODAY,
  T_NEXT_WEEK,
  T_P3_OPEN,
  T_PLANTED,
  T_QBR_DECK,
  T_SPLIT,
  T_SPLIT2,
  T_UNDATED,
  UBUNTU,
  answerProblems,
  baseActivities,
  bucketRows,
  calendarRows,
  installActivitiesMock,
  isBucketRead,
  isCalendarRead,
  isCreateActivity,
  isUpdateActivity,
  servedData,
  type ActivitiesMock,
  type ActivitiesMockOptions,
  type Bucket,
  type StoredActivity,
} from './support/activities-mock';

/**
 * T-0083 — the P07 activities screen (`docs/design/P07/`, final exports):
 * My tasks, the calendar, the composer, snooze and reschedule, behind
 * `crm_activities`, in the CRM shell T-0042 built. Written by the lead's QA
 * agent BEFORE the screen exists;
 * `tests/acceptance/records-ui/activities-screen.acceptance.test.ts` runs this
 * file with `--grep @p07` and reads every outcome by tag.
 * Decisions: D-L97, D-L98, D-L102, D-L105, D-L107, D-P13, D-P18, D-P21, D-P22.
 *
 * TAG RULE (D-L84). `@p07` is the parent tag. Playwright's --grep is a regular
 * expression, so no other screen's tag may contain it, and it contains no
 * other screen's parent tag. Every sub-tag here is `@p07-<name>`.
 *
 * ---------------------------------------------------------------------------
 * THE WEB PROCESS
 *
 *   webUrl             — the default server, every flag at its default.
 *                        `/activities` must be a real 404 there.
 *   webActivitiesUrl   — NEW, published in the stack file by the builder's
 *                        change to `scripts/run-e2e.mjs`. `crm_activities`
 *                        RIDES ON THE RECORDS PROCESS (`webRecordsUrl`), as
 *                        `crm_accounts`, `crm_record_view` and `crm_leads` do,
 *                        and `webActivitiesUrl` names the same URL. That
 *                        process serves `/contacts/[id]` and `/accounts/[id]`,
 *                        so the summaries on this screen link to them and every
 *                        link resolves. Every journey and the byte budget run
 *                        here.
 *
 * THE ACTIVITIES ARE READ FROM THE BROWSER, AND MOCKED THERE
 *
 * Every journey installs `support/activities-mock.ts`, which serves
 * listMyActivities, listCalendar, createActivity, updateActivity, the
 * composer's picker (listContacts and listAccounts with `q`),
 * listMyProgrammes and getCurrentUser from the contracts, and checks every
 * answer it gives against them. `afterEach` fails a test in which the screen
 * sent the API anything the contract (or this screen's rules, in the mock's
 * header) does not allow, left the origin, or in which the mock answered
 * something its own contract rejects.
 *
 * THE CLOCK. Every journey fixes the browser's clock to the mock's NOW
 * (22:30 UTC, Wednesday 30 September 2026) with `page.clock.setFixedTime`:
 * timers still run, only `Date` is pinned. In Lagos that is 23:30 on the 30th;
 * in Johannesburg and Nairobi it is already Thursday 1 October.
 *
 * THE DOM HOOKS THIS FILE RELIES ON (the builder's side of the contract)
 *
 *   [data-shell="crm"]                       the CRM shell; its <nav> links
 *     a[href="/activities"]                  with aria-current="page" here
 *   [data-screen="P07"]                      the screen root; `/activities`
 *                                            opens on My tasks
 *   [data-action="view-tasks"], [data-action="view-calendar"]
 *   [data-testid="my-tasks"]                 P07/01, containing
 *     [data-bucket="overdue|today|upcoming"] one group per bucket, in that
 *                                            order, naming its bucket, with no
 *                                            count
 *       [data-activity="<id>"]               one task, in served order, with
 *         data-activity-type="task"
 *         [data-field="subject"]             (data-locked="true" if withheld)
 *         [data-field="dueAt"]               a <time datetime> when dated
 *                                            (data-locked="true" if withheld)
 *         [data-related="contact|account"]   the summary: a link to
 *                                            /contacts/<id> or /accounts/<id>
 *                                            for a well-formed uuid, else text;
 *                                            data-locked="true" if withheld
 *         [data-action="complete-task"]
 *         [data-action="snooze"]             opens [data-testid="snooze-menu"]
 *                                            holding [data-snooze-option]
 *                                            presets (at least one)
 *         [data-action="reschedule"]         on the row, or in the snooze menu
 *       [data-testid="bucket-skeleton"|"bucket-empty"|"bucket-error"|"bucket-more"]
 *     [data-testid="tasks-skeleton"]         (or a bucket-skeleton per bucket)
 *     [data-testid="tasks-empty"]            every bucket empty
 *   [data-testid="calendar"]                 P07/03–04, data-range="week|month"
 *     [data-action="calendar-week"|"calendar-month"|"calendar-prev"|"calendar-next"|"calendar-today"]
 *     [data-calendar-day="YYYY-MM-DD"]       one day (cell or column), the date
 *                                            in the BROWSER's zone; today has
 *                                            aria-current="date"; it CONTAINS
 *                                            the events that start on it
 *     [data-calendar-event="<id>"]           one task or meeting, with
 *       data-activity-type="task|meeting"
 *       data-completed="true|false"          on a task whose completedAt is
 *                                            served; absent when withheld
 *       <time datetime="<ISO>">              the start; a meeting's end too
 *       [data-action="reschedule"], [data-action="complete-task"]
 *                                            in the event, or in
 *                                            [data-testid="event-detail"]
 *                                            after clicking it
 *     [data-testid="calendar-skeleton"|"calendar-empty"|"calendar-error"]
 *   [data-action="compose"]                  opens
 *   [data-testid="activity-composer"]        role=dialog, with
 *     [data-activity-type="task|meeting"]    the type choice
 *     [data-field-input="subject"], [data-field-input="target"] (ONE search
 *                                            box over contacts AND accounts:
 *                                            listContacts and listAccounts, q)
 *     [data-target-option="<id>"]            a picker result, by name, with
 *       data-target-type="contact|account"
 *     [data-field-input="dueAt"]             input[type="datetime-local"], tasks
 *     [data-field-input="startsAt"], [data-field-input="endsAt"]
 *                                            input[type="datetime-local"],
 *                                            meetings
 *     [data-field-error="<field>"]           a translated validation message
 *     [data-action="save-activity"], [role="alert"] for a refusal
 *   [data-testid="reschedule-form"]          role=dialog: [data-field-input=
 *                                            "dueAt"] (a task) or "startsAt"
 *                                            and "endsAt" (a meeting), each a
 *                                            datetime-local PREFILLED with the
 *                                            served time in the browser's zone;
 *                                            [data-field-error], [data-conflict]
 *                                            (D-L102's "changed by someone
 *                                            else"), [data-action=
 *                                            "save-reschedule"], [role="alert"]
 *   <time datetime="<ISO>">                  EVERY date or time drawn, the
 *                                            calendar's day headers included
 *                                            (en-XA skips <time>, nothing else)
 *   [data-requires-connection]               on every write control
 *   [data-testid="offline-banner"]           with the last-synced time
 *   [data-record-text]                       record data, not UI copy (en-XA)
 *
 * PINNED INTERFACES BEYOND THE HOOKS
 *
 *   - `timeZone` is the browser's resolved IANA zone, sent on every
 *     listMyActivities read, never a constant and never left to the server.
 *   - Each bucket is its own listMyActivities read, read once on load, and
 *     paged by "more" (`nextCursor`, echoed exactly), never by a count.
 *   - The calendar's window is computed in the browser's zone: `from` and
 *     `to` are local midnights; a week is seven days; a month view covers the
 *     whole month; no request is ever longer than 42 days. Every page of the
 *     window is read (a calendar with a missing event is wrong), each cursor
 *     echoed exactly.
 *   - Every write sends `version` plus ONLY what changed (D-L102). After a 409
 *     the screen re-reads by itself, and the form becomes the fresh row with
 *     the person's edits re-applied; a field both changed keeps the typed
 *     value with a [data-conflict] note; a field they never touched is never
 *     sent, after any number of 409s. Nothing is optimistic.
 *   - The composer sets the owner to the caller (from /auth/me) and one
 *     target, picked by name. A meeting's times are checked before sending:
 *     both present, the end after the start (equal is not after), at most
 *     24 hours (exactly 24 is allowed). A bad one is a translated message and
 *     nothing is sent.
 *   - A 403 `field_not_editable` is its own translated message, never retried.
 *
 * DESIGN AGAINST CONTRACT — WHERE THEY DISAGREE THE CONTRACT WINS
 *
 *   Hidden (D-L105, D-P13, D-P21, D-P22): priority chips, bulk select,
 *   reassign and snooze, Undo after completing (no reopening, D-L81), Google
 *   and Microsoft events and the "connect your calendar" prompt, public
 *   holidays, the AI meeting brief, booking pages, field check-in, attendees,
 *   locations, reminder channels, the offline queue and its "Queued" badge,
 *   the "done today" and "best week" counts, and the Visit, Demo and Internal
 *   types. The design's "always WAT" label is the browser's zone here, so a
 *   Nairobi desk never reads "WAT". Dragging an event is the builder's choice;
 *   the reschedule form is the control (WCAG 2.2 SC 2.5.7).
 * ---------------------------------------------------------------------------
 */

const SCREEN = '[data-screen="P07"]';

/**
 * The /activities transferred-byte budget. PROVISIONAL: the acceptance suite
 * holds it at or under 255,000 bytes and within 5% of what this run
 * measures, so the builder measures it and the lead re-pins it to the
 * measurement. Why 255,000: see the budget test.
 */
const ACTIVITIES_BUDGET_BYTES = 270_500;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EN = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>;

const LAGOS = 'Africa/Lagos';
const JOHANNESBURG = 'Africa/Johannesburg';
const NAIROBI = 'Africa/Nairobi';
type Zone = typeof LAGOS | typeof JOHANNESBURG | typeof NAIROBI;
const ZONES: readonly Zone[] = [LAGOS, JOHANNESBURG, NAIROBI];

/**
 * The oracle, written out by hand and independent of the mock: none of these
 * zones keeps daylight saving, so local time is UTC plus a fixed offset.
 */
const OFFSET_HOURS: Readonly<Record<Zone, number>> = { [LAGOS]: 1, [JOHANNESBURG]: 2, [NAIROBI]: 3 };
const ZONE_WORDS: Readonly<Record<Zone, RegExp>> = {
  [LAGOS]: /\bWAT\b|\bLagos\b|West Africa/i,
  [JOHANNESBURG]: /\bSAST\b|\bJohannesburg\b|South Africa/i,
  [NAIROBI]: /\bEAT\b|\bNairobi\b|East Africa/i,
};

/** Which bucket each open task is in, per zone, at NOW. Written by hand from the contract's rule. */
const EXPECTED_BUCKETS: Readonly<Record<Zone, Readonly<Record<Bucket, readonly StoredActivity[]>>>> = {
  [LAGOS]: {
    overdue: [T_EMEKA, T_QBR_DECK, T_KWARA],
    today: [T_LATE_TODAY],
    upcoming: [T_SPLIT, T_SPLIT2, T_HOSTILE, T_P3_OPEN, T_NEXT_WEEK, T_UNDATED],
  },
  [JOHANNESBURG]: {
    overdue: [T_EMEKA, T_QBR_DECK, T_KWARA],
    today: [T_LATE_TODAY, T_SPLIT, T_SPLIT2],
    upcoming: [T_HOSTILE, T_P3_OPEN, T_NEXT_WEEK, T_UNDATED],
  },
  [NAIROBI]: {
    overdue: [T_EMEKA, T_QBR_DECK, T_KWARA],
    today: [T_LATE_TODAY, T_SPLIT],
    upcoming: [T_SPLIT2, T_HOSTILE, T_P3_OPEN, T_NEXT_WEEK, T_UNDATED],
  },
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW_MS = Date.parse(NOW);

function offsetMs(zone: Zone): number {
  return OFFSET_HOURS[zone] * HOUR;
}

/** `YYYY-MM-DD` of an instant in the zone. */
function localDate(iso: string | number, zone: Zone): string {
  return new Date((typeof iso === 'number' ? iso : Date.parse(iso)) + offsetMs(zone)).toISOString().slice(0, 10);
}

/** The datetime-local value of an instant in the zone. */
function localInput(iso: string, zone: Zone): string {
  return new Date(Date.parse(iso) + offsetMs(zone)).toISOString().slice(0, 16);
}

/** The UTC instant a datetime-local value means in the zone. */
function fromLocalInput(value: string, zone: Zone): number {
  return Date.parse(`${value}:00.000Z`) - offsetMs(zone);
}

function isLocalMidnight(ms: number, zone: Zone): boolean {
  return (ms + offsetMs(zone)) % DAY === 0;
}

/** The clock time of an instant in the zone, 24-hour or 12-hour, as a pattern. */
function clockPattern(iso: string, zone: Zone): RegExp {
  const local = new Date(Date.parse(iso) + offsetMs(zone));
  const h = local.getUTCHours();
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const meridiem = h < 12 ? '[Aa]\\.?[Mm]' : '[Pp]\\.?[Mm]';
  return new RegExp(`(?<!\\d)${String(h).padStart(2, '0')}[:.]${mm}(?!\\d)|(?<!\\d)${h}[:.]${mm}(?!\\d)(?!\\s?[AaPp]\\.?[Mm])|(?<!\\d)${h12}[:.]${mm}\\s?${meridiem}`);
}

/** The bucket a due time is in, in Lagos, at NOW (Lagos' next midnight is 23:00Z on the 30th). */
function lagosBucketOf(dueAt: string): Bucket {
  const due = Date.parse(dueAt);
  if (due < NOW_MS) return 'overdue';
  return due < Date.parse('2026-09-30T23:00:00.000Z') ? 'today' : 'upcoming';
}

// Kasuwa's users are in WAT/EAT/SAST; every time on this screen is converted in the browser.
test.use({ timezoneId: LAGOS });

let active: ActivitiesMock | undefined;

test.afterEach(async ({ page }) => {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.mockFaults, 'the MOCK answered something its contract rejects (a mock bug, not the screen’s)').toEqual([]);
    expect(mock.violations, 'the screen sent the API something the contract or this screen’s rules do not allow').toEqual([]);
    if (mock.requests.length > 0) {
      const origin = new URL(activitiesUrl()).origin;
      for (const url of mock.requests) {
        expect(url.origin, 'the activities must be read same-origin, by a relative path').toBe(origin);
      }
    }
  }
});

function activitiesUrl(): string {
  const urls = stack() as StackUrls & { webActivitiesUrl?: string };
  if (typeof urls.webActivitiesUrl !== 'string' || urls.webActivitiesUrl === '') {
    throw new Error(
      'the stack file has no webActivitiesUrl: scripts/run-e2e.mjs starts no web process with crm_activities on ' +
        '(see the header of p07-activities.spec.ts)',
    );
  }
  return urls.webActivitiesUrl;
}

function screen(page: Page): Locator {
  return page.locator(SCREEN);
}

/** Visible elements only: a screen may render desktop and mobile layouts and switch them with CSS. */
function shown(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

function bucket(page: Page, name: Bucket): Locator {
  return shown(screen(page).locator(`[data-testid="my-tasks"] [data-bucket="${name}"]`)).first();
}

function row(page: Page, id: string): Locator {
  return shown(screen(page).locator(`[data-testid="my-tasks"] [data-activity="${id}"]`)).first();
}

function calendar(page: Page): Locator {
  return shown(screen(page).getByTestId('calendar')).first();
}

function events(page: Page, id: string): Locator {
  return shown(screen(page).locator(`[data-testid="calendar"] [data-calendar-event="${id}"]`));
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

/** UI copy only: visible text with record data ([data-record-text]) and icon ligatures removed. */
async function copyText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"], [data-record-text], time').forEach((hidden) => hidden.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

function labelsEndingWith(...suffixes: string[]): string[] {
  return Object.entries(EN)
    .filter(([id]) => suffixes.some((suffix) => id.endsWith(suffix)))
    .map(([, text]) => text);
}

/** Labels for a meeting-time rule, under an id about activities, meetings or the calendar. */
function meetingRuleLabels(...codes: string[]): string[] {
  return Object.entries(EN)
    .filter(([id]) => /activit|meeting|calendar/i.test(id) && codes.some((code) => id.endsWith(`.${code}`)))
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

function json(body: unknown): Record<string, unknown> {
  expect(typeof body === 'object' && body !== null && !Array.isArray(body), 'the write body is not an object').toBe(true);
  return body as Record<string, unknown>;
}

function keysOf(body: Record<string, unknown>): string[] {
  return Object.keys(body).sort();
}

function absentOrNull(body: Record<string, unknown>, key: string): boolean {
  return body[key] === undefined || body[key] === null;
}

async function openActivities(
  page: Page,
  options: ActivitiesMockOptions & { query?: string; zone?: Zone } = {},
): Promise<ActivitiesMock> {
  const zone = options.zone ?? LAGOS;
  await page.clock.setFixedTime(new Date(NOW));
  const mock = await installActivitiesMock(page, { browserTimeZone: zone, ...options });
  active = mock;
  const response = await page.goto(`${activitiesUrl()}/activities${options.query ?? ''}`);
  expect(response?.status(), '/activities with crm_activities on').toBe(200);
  await expect(screen(page)).toBeVisible();
  return mock;
}

/** Waits for the three buckets' first pages to be drawn (rows, or an empty or error state). */
async function bucketsSettled(page: Page): Promise<void> {
  for (const name of BUCKETS as Bucket[]) {
    await expect(
      bucket(page, name).locator('[data-activity], [data-testid="bucket-empty"], [data-testid="bucket-error"]').first(),
      `the ${name} bucket never drew its first page`,
    ).toBeVisible();
  }
}

/** The task ids drawn in a bucket, in DOM order. */
async function bucketIds(page: Page, name: Bucket): Promise<string[]> {
  return shown(screen(page).locator(`[data-testid="my-tasks"] [data-bucket="${name}"] [data-activity]`)).evaluateAll((rows) =>
    rows.map((element) => element.getAttribute('data-activity') ?? ''),
  );
}

/** Every bucket's ids, for polling where a task now sits. */
async function whereIs(page: Page, id: string): Promise<string> {
  for (const name of BUCKETS as Bucket[]) {
    if ((await bucketIds(page, name)).includes(id)) return name;
  }
  return 'nowhere';
}

/** The bucket element's own copy, rows removed: where a count would be drawn. */
async function bucketChrome(page: Page, name: Bucket): Promise<string> {
  return bucket(page, name).evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    // A date in a bucket's header is a <time>, and allowed; any other digit is a count.
    copy.querySelectorAll('[data-activity], [aria-hidden="true"], time').forEach((node) => node.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/** Opens the calendar and waits for its first window to be read and drawn. */
async function openCalendar(page: Page): Promise<Response> {
  const read = page.waitForResponse((response) => isCalendarRead(response.request()));
  await shown(screen(page).locator('[data-action="view-calendar"]')).first().click();
  const first = await read;
  await expect(calendar(page)).toBeVisible();
  return first;
}

function windowOf(url: URL): { from: number; to: number } {
  return { from: Date.parse(url.searchParams.get('from') ?? ''), to: Date.parse(url.searchParams.get('to') ?? '') };
}

/** The day cell an event's first drawn copy sits in. */
async function dayOfEvent(page: Page, id: string): Promise<string[]> {
  return events(page, id).evaluateAll((copies) =>
    copies.map((element) => element.closest('[data-calendar-day]')?.getAttribute('data-calendar-day') ?? ''),
  );
}

/** What a calendar window should list, by the contract's rule (independent of the mock's filter). */
function expectedInWindow(rows: readonly StoredActivity[], from: number, to: number): StoredActivity[] {
  return rows.filter((entry) => {
    if (entry.type === 'task') return entry.dueAt !== null && Date.parse(entry.dueAt) >= from && Date.parse(entry.dueAt) < to;
    return entry.startsAt !== null && entry.endsAt !== null && Date.parse(entry.startsAt) < to && Date.parse(entry.endsAt) > from;
  });
}

/** Clicks an event's control: in the event, or in the event detail it opens. */
async function eventAction(page: Page, id: string, action: string): Promise<void> {
  const event = events(page, id).first();
  const inside = shown(event.locator(`[data-action="${action}"]`));
  if ((await inside.count()) > 0) {
    await inside.first().click();
    return;
  }
  await event.click();
  await shown(page.locator(`[data-testid="event-detail"] [data-action="${action}"]`)).first().click();
}

/** Opens the reschedule form for a task row: on the row, or in its snooze menu. */
async function rescheduleRow(page: Page, id: string): Promise<Locator> {
  const target = row(page, id);
  const direct = shown(target.locator('[data-action="reschedule"]'));
  if ((await direct.count()) > 0) {
    await direct.first().click();
  } else {
    await shown(target.locator('[data-action="snooze"]')).first().click();
    await shown(page.locator('[data-testid="snooze-menu"] [data-action="reschedule"]')).first().click();
  }
  return rescheduleForm(page);
}

async function rescheduleForm(page: Page): Promise<Locator> {
  const form = shown(page.getByTestId('reschedule-form')).first();
  await expect(form, 'no reschedule form opened').toBeVisible();
  await expect(form).toHaveAttribute('role', 'dialog');
  return form;
}

function input(scope: Locator, name: string): Locator {
  return scope.locator(`[data-field-input="${name}"]`).first();
}

async function openComposer(page: Page, type: 'task' | 'meeting'): Promise<Locator> {
  await shown(screen(page).locator('[data-action="compose"]')).first().click();
  const composer = shown(page.getByTestId('activity-composer')).first();
  await expect(composer, 'the composer did not open').toBeVisible();
  await expect(composer).toHaveAttribute('role', 'dialog');
  await shown(composer.locator(`[data-activity-type="${type}"]`)).first().click();
  return composer;
}

/** Types a name into the composer's picker and chooses the served record. */
async function pickTarget(page: Page, composer: Locator, term: string, id: string, kind: 'contact' | 'account'): Promise<void> {
  await input(composer, 'target').fill(term);
  const option = shown(page.locator(`[data-target-option="${id}"]`)).first();
  await expect(option, `the picker did not offer the ${kind} for "${term}"`).toBeVisible();
  await expect(option).toHaveAttribute('data-target-type', kind);
  await option.click();
}

const PSEUDO = /[·[\]äëïöüÄËÏÖÜ]/;

/** Everything the screen was served that could land on the device. */
function needles(): string[] {
  const out = new Set<string>();
  for (const entry of baseActivities()) {
    if (entry.subject !== null) out.add(entry.subject);
    out.add(entry.id);
    if (entry.contact !== null) out.add(entry.contact.displayName);
    if (entry.account !== null) out.add(entry.account.name);
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

test('the contract mock refuses what the contract and the screen’s rules refuse, and checks its own answers @p07 @p07-mock', async ({
  page,
}) => {
  // A validator only ever seen accepting proves nothing. Drive the mock with
  // fetch() from a page that exists today (sign-in on the default server) and
  // watch every malformed request land in `violations`, one at a time. No
  // `active` mock here: the violations are deliberate and counted explicitly.
  const { webUrl } = stack();

  // The two oracles agree: the mock's bucket rule and the table written by hand.
  for (const zone of ZONES) {
    for (const name of BUCKETS as Bucket[]) {
      expect(
        bucketRows(baseActivities(), name, zone).map((entry) => entry.id),
        `the mock and the hand-written table disagree on ${zone} ${name}`,
      ).toEqual(EXPECTED_BUCKETS[zone][name].map((entry) => entry.id));
    }
  }
  // And on what a window holds.
  const lagosWeek = { from: Date.parse('2026-09-27T23:00:00.000Z'), to: Date.parse('2026-10-04T23:00:00.000Z') };
  expect(calendarRows(baseActivities(), new Date(lagosWeek.from).toISOString(), new Date(lagosWeek.to).toISOString()).map((entry) => entry.id).sort()).toEqual(
    expectedInWindow(baseActivities(), lagosWeek.from, lagosWeek.to).map((entry) => entry.id).sort(),
  );
  expect(expectedInWindow(baseActivities(), lagosWeek.from, lagosWeek.to).map((entry) => entry.id)).toEqual(
    expect.arrayContaining([M_PREV.id, M_QBR.id, M_LATE.id, M_RESCHED.id, T_DONE.id, T_DONE_LOCKED.id]),
  );

  const mock = await installActivitiesMock(page, { browserTimeZone: LAGOS });
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
  const my = (query: string) => `/api/v1/me/activities?${query}`;
  const lagos = `timeZone=${encodeURIComponent(LAGOS)}`;
  const cal = (from: string, to: string, extra = '') => `/api/v1/me/calendar?from=${from}&to=${to}${extra}`;
  const patch = (id: string) => `/api/v1/activities/${id}`;

  // Served as the contract says.
  const overdue = await call(my(`${lagos}&bucket=overdue`));
  expect(overdue.status).toBe(200);
  expect((overdue.body.data as { id: string }[]).map((entry) => entry.id)).toEqual([T_EMEKA.id, T_QBR_DECK.id, T_KWARA.id]);
  const kwara = (overdue.body.data as Record<string, unknown>[])[2] ?? {};
  expect('subject' in kwara, 'a withheld subject was sent').toBe(false);
  expect(kwara.withheldFields).toEqual(['subject']);
  const upcoming = await call(my(`${lagos}&bucket=upcoming&limit=2`));
  expect((upcoming.body.data as unknown[]).length, 'a page with a cursor is short of its limit').toBe(2);
  const upCursor = String(upcoming.body.nextCursor);
  const upcoming2 = await call(my(`${lagos}&bucket=upcoming&limit=2&cursor=${encodeURIComponent(upCursor)}`));
  expect((upcoming2.body.data as { id: string }[]).map((entry) => entry.id)).toEqual([T_HOSTILE.id, T_P3_OPEN.id]);
  const week = await call(cal('2026-09-27T23:00:00.000Z', '2026-10-04T23:00:00.000Z', '&limit=3'));
  expect(week.status).toBe(200);
  expect((week.body.data as { id: string }[]).map((entry) => entry.id)).toEqual([M_PREV.id, T_DONE.id, T_DONE_LOCKED.id]);
  const weekCursor = String(week.body.nextCursor);
  const done = (week.body.data as Record<string, unknown>[])[2] ?? {};
  expect('completedAt' in done, 'a withheld completedAt was sent').toBe(false);
  const longest = await call(cal('2026-08-31T23:00:00.000Z', '2026-10-12T23:00:00.000Z'));
  expect(longest.status, 'exactly 42 days was refused').toBe(200);
  const contacts = await call('/api/v1/contacts?q=adaeze&limit=10');
  expect((contacts.body.data as { id: string }[]).map((entry) => entry.id)).toEqual([PICK_CONTACT.id]);
  const accounts = await call('/api/v1/accounts?q=oja');
  expect((accounts.body.data as unknown[]).length, 'the account search is not diacritic-insensitive').toBe(2);
  expect(mock.violations, 'a well-formed request was recorded as a violation').toEqual([]);

  // Reads, refused and blamed on the screen.
  await expectViolation(my('bucket=overdue'), 'GET', undefined, 400, /no timeZone/);
  await expectViolation(my('timeZone=WAT&bucket=overdue'), 'GET', undefined, 400, /not an IANA zone/);
  await expectViolation(my(`timeZone=${encodeURIComponent('+01:00')}&bucket=overdue`), 'GET', undefined, 400, /not an IANA zone/);
  await expectViolation(my(`timeZone=${encodeURIComponent('../etc')}&bucket=overdue`), 'GET', undefined, 400, /not an IANA zone/);
  await expectViolation(my(`timeZone=${encodeURIComponent(NAIROBI)}&bucket=overdue`), 'GET', undefined, 200, /guessed, not read/);
  await expectViolation(my(`${lagos}&bucket=later`), 'GET', undefined, 400, /not one of/);
  await expectViolation(my(`${lagos}&bucket=today&limit=0`), 'GET', undefined, 400, /outside 1\.\.100/);
  await expectViolation(my(`${lagos}&bucket=today&owner=me`), 'GET', undefined, 400, /no "owner"/);
  await expectViolation(my(`${lagos}&bucket=today&cursor=forged`), 'GET', undefined, 400, /never build/);
  await expectViolation(my(`${lagos}&bucket=today&cursor=${encodeURIComponent(upCursor)}`), 'GET', undefined, 400, /never build/);
  await expectViolation(cal('2026-08-31T23:00:00.000Z', '2026-10-13T23:00:00.000Z'), 'GET', undefined, 400, /over the 42-day limit/);
  await expectViolation(cal('2026-09-27T23:00:00.000Z', '2026-09-27T23:00:00.000Z'), 'GET', undefined, 400, /not after from/);
  await expectViolation(cal(encodeURIComponent('2026-09-28T00:00:00+01:00'), '2026-10-04T23:00:00.000Z'), 'GET', undefined, 400, /not a UTC date-time/);
  await expectViolation(cal('2026-09-27T23:00:00.000Z', '2026-10-04T23:00:00.000Z', `&${lagos}`), 'GET', undefined, 400, /no "timeZone"/);
  await expectViolation(cal('2026-09-26T23:00:00.000Z', '2026-10-03T23:00:00.000Z', `&cursor=${encodeURIComponent(weekCursor)}`), 'GET', undefined, 400, /never build/);
  await expectViolation('/api/v1/contacts?q=ada&programmeId=x', 'GET', undefined, 400, /no "programmeId"/);
  await expectViolation(my(`${lagos}&bucket=today`), 'GET', undefined, 200, /scope is never supplied/, { 'x-kasuwa-programme-id': PROGRAMME_ONE.id });
  // Not operations P07 uses: an external calendar, a holiday list, a count.
  await expectViolation('/api/v1/me/calendar/google', 'GET', undefined, 404, /not an operation/);
  await expectViolation('/api/v1/me/activities/count', 'GET', undefined, 404, /not an operation/);

  // Creates, refused and blamed on the screen.
  const meeting = { type: 'meeting', subject: 'Pricing review', accountId: PICK_ACCOUNT.id, ownerUserId: ME.id };
  await expectViolation('/api/v1/activities', 'POST', { ...meeting, startsAt: '2026-10-02T13:00:00.000Z' }, 400, /endsAt required/);
  await expectViolation('/api/v1/activities', 'POST', { ...meeting, startsAt: '2026-10-02T13:00:00.000Z', endsAt: '2026-10-02T13:00:00.000Z' }, 400, /invalid_range/);
  await expectViolation('/api/v1/activities', 'POST', { ...meeting, startsAt: '2026-10-02T13:00:00.000Z', endsAt: '2026-10-03T13:00:01.000Z' }, 400, /too_long/);
  await expectViolation('/api/v1/activities', 'POST', { ...meeting, startsAt: '2026-10-02T13:00:00.000Z', endsAt: '2026-10-02T14:00:00.000Z', dueAt: '2026-10-02T13:00:00.000Z' }, 400, /task_only/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'task', subject: 'x', contactId: PICK_CONTACT.id, ownerUserId: ME.id, startsAt: '2026-10-02T13:00:00.000Z' }, 400, /meeting_only/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'task', subject: 'x', contactId: PICK_CONTACT.id, ownerUserId: EMEKA.id }, 400, /composes for the caller/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'task', subject: 'x', contactId: PICK_CONTACT.id }, 400, /composes for the caller/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'task', subject: 'x', contactId: BISI.id, ownerUserId: ME.id }, 404, /picker never served/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'task', subject: 'x', contactId: PICK_CONTACT.id, accountId: PICK_ACCOUNT.id, ownerUserId: ME.id }, 400, /exactly one target/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'task', subject: 'x', dueAt: '2026-10-02T14:00', contactId: PICK_CONTACT.id, ownerUserId: ME.id }, 400, /UTC date-time/);

  // Updates, refused and blamed on the screen. Everything named here was served above.
  await expectViolation(patch('00000000-0000-4000-8000-00000000dead'), 'PATCH', { version: 1, completed: true }, 404, /never served/);
  await expectViolation(patch(T_EMEKA.id), 'PATCH', { version: 7, completed: true }, 409, /never served/);
  await expectViolation(patch(T_EMEKA.id), 'PATCH', { version: 1, startsAt: '2026-10-02T13:00:00.000Z' }, 400, /meeting_only/);
  await expectViolation(patch(M_PREV.id), 'PATCH', { version: 1, dueAt: '2026-10-02T13:00:00.000Z' }, 400, /task_only/);
  await expectViolation(patch(M_PREV.id), 'PATCH', { version: 1, completed: true }, 400, /task_only/);
  await expectViolation(patch(M_PREV.id), 'PATCH', { version: 1, endsAt: '2026-09-27T19:00:00.000Z' }, 400, /invalid_range/);
  await expectViolation(patch(M_PREV.id), 'PATCH', { version: 1, endsAt: '2026-09-28T21:00:00.000Z' }, 400, /too_long/);
  await expectViolation(patch(T_P3_OPEN.id), 'PATCH', { version: 1, dueAt: T_P3_OPEN.dueAt }, 200, /sent unchanged/);
  await expectViolation(patch(T_EMEKA.id), 'PATCH', { version: 1, completed: true, programmeId: PROGRAMME_ONE.id }, 400, /closed body/);
  // A read-only field is the API's 403, not the screen's violation.
  const readOnly = await call(patch(T_KWARA.id), 'PATCH', { version: T_KWARA.version, dueAt: '2026-10-09T08:00:00.000Z' });
  expect(readOnly.status).toBe(403);
  expect(readOnly.body.details).toEqual([{ path: 'dueAt', code: 'field_not_editable' }]);
  expect(mock.violations.length, 'the refusals above were not all recorded, or one was recorded twice').toBe(planted);

  // D-L102 on the wire: somebody else moves the start twice; the blind retry, the
  // undoing resend and the honest rebase are told apart.
  const stale = await installActivitiesMock(page, {
    concurrent: { activityId: M_RESCHED.id, changes: [{ startsAt: '2026-10-02T08:30:00.000Z' }] },
  });
  await call(cal('2026-09-27T23:00:00.000Z', '2026-10-04T23:00:00.000Z', '&limit=100'));
  const lost = await call(patch(M_RESCHED.id), 'PATCH', { version: M_RESCHED.version, endsAt: '2026-10-02T10:30:00.000Z' });
  expect(lost.status).toBe(409);
  expect(stale.violations, 'a write beaten by somebody else was blamed on the screen').toEqual([]);
  expect((await call(patch(M_RESCHED.id), 'PATCH', { version: M_RESCHED.version, endsAt: '2026-10-02T10:30:00.000Z' })).status).toBe(409);
  expect(stale.violations.join('\n'), 'a blind retry was not recorded').toMatch(/blind retry/);
  const fresh = await call(cal('2026-09-27T23:00:00.000Z', '2026-10-04T23:00:00.000Z', '&limit=100'));
  const moved = (fresh.body.data as { id: string; version: number; startsAt: string }[]).find((entry) => entry.id === M_RESCHED.id);
  expect(moved?.version).toBe(M_RESCHED.version + 1);
  expect(moved?.startsAt).toBe('2026-10-02T08:30:00.000Z');
  const undo = await call(patch(M_RESCHED.id), 'PATCH', { version: moved?.version, startsAt: M_RESCHED.startsAt, endsAt: '2026-10-02T10:30:00.000Z' });
  expect(undo.status, 'a resend of the replaced start was not let through to show the damage').toBe(200);
  expect(stale.violations.join('\n'), 'resending the old start was not recorded').toMatch(/just replaced/);
  expect(stale.mockFaults).toEqual([]);

  // The honest second save: only what the person changed, on the fresh version.
  const honest = await installActivitiesMock(page, {
    concurrent: { activityId: M_RESCHED.id, changes: [{ startsAt: '2026-10-02T08:30:00.000Z' }] },
  });
  await call(cal('2026-09-27T23:00:00.000Z', '2026-10-04T23:00:00.000Z', '&limit=100'));
  expect((await call(patch(M_RESCHED.id), 'PATCH', { version: M_RESCHED.version, endsAt: '2026-10-02T10:30:00.000Z' })).status).toBe(409);
  await call(cal('2026-09-27T23:00:00.000Z', '2026-10-04T23:00:00.000Z', '&limit=100'));
  const rebased = await call(patch(M_RESCHED.id), 'PATCH', { version: M_RESCHED.version + 1, endsAt: '2026-10-02T10:30:00.000Z' });
  expect(rebased.status).toBe(200);
  expect(rebased.body).toMatchObject({ startsAt: '2026-10-02T08:30:00.000Z', endsAt: '2026-10-02T10:30:00.000Z', version: M_RESCHED.version + 2 });
  expect(honest.violations, 'the honest rebase was recorded as a violation').toEqual([]);

  // Well-formed writes are applied.
  const writer = await installActivitiesMock(page);
  await call('/api/v1/contacts?q=Adaeze');
  const created = await call('/api/v1/activities', 'POST', { type: 'task', subject: 'Send the delivery note', dueAt: '2026-10-01T08:30:00.000Z', contactId: PICK_CONTACT.id, ownerUserId: ME.id });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ id: NEW_ACTIVITY_IDS[0], type: 'task', ownerUserId: ME.id, version: 1, startsAt: null, endsAt: null });
  const listed = await call(my(`${lagos}&bucket=upcoming`));
  expect((listed.body.data as { id: string }[]).map((entry) => entry.id), 'a created task did not join its bucket').toContain(NEW_ACTIVITY_IDS[0]);
  await call(my(`${lagos}&bucket=overdue`));
  const completed = await call(patch(T_EMEKA.id), 'PATCH', { version: T_EMEKA.version, completed: true });
  expect(completed.status).toBe(200);
  expect(completed.body.version).toBe(T_EMEKA.version + 1);
  const after = await call(my(`${lagos}&bucket=overdue`));
  expect((after.body.data as { id: string }[]).map((entry) => entry.id), 'a completed task stayed in its bucket').not.toContain(T_EMEKA.id);
  expect(writer.violations).toEqual([]);
  expect(writer.mockFaults).toEqual([]);

  // The mock checks its own answers: a planted body the contract rejects is caught.
  const item = (overdue.body.data as Record<string, unknown>[])[0] ?? {};
  expect(answerProblems('listMyActivities', 200, { data: [], nextCursor: null, total: 3 }).join('\n'), 'a page with a total passed').toMatch(/total/);
  expect(answerProblems('listMyActivities', 200, { data: [{ ...item, body: 'x' }], nextCursor: null }).join('\n')).toMatch(/body/);
  expect(answerProblems('listMyActivities', 200, { data: [{ ...item, priority: 'high' }], nextCursor: null }).join('\n')).toMatch(/priority/);
  expect(answerProblems('listMyActivities', 200, { data: [{ ...item, ownerUserId: ME.id }], nextCursor: null }).join('\n')).toMatch(/ownerUserId/);
  expect(answerProblems('listCalendar', 200, { data: [{ ...item, type: 'note' }], nextCursor: null })).not.toEqual([]);
  expect(answerProblems('listCalendar', 200, { data: [{ ...item, attendees: [] }], nextCursor: null })).not.toEqual([]);
  expect(answerProblems('listCalendar', 403, { statusCode: 403 }).join('\n')).toMatch(/declares no 403/);
  expect(answerProblems('listMyActivities', 200, { data: [item], nextCursor: null })).toEqual([]);

  // The deliberate faults are served and filed apart; the planted times are schema-valid.
  const hostile = await installActivitiesMock(page, { hostileSummaries: true });
  await call(my(`${lagos}&bucket=overdue`));
  expect(hostile.plantedFaults.length, 'the hostile summaries were not served').toBe(2);
  expect(hostile.mockFaults).toEqual([]);
  const plantedTimes = await installActivitiesMock(page, { plantWithheldTimes: true });
  const withPlanted = await call(my(`${lagos}&bucket=upcoming`));
  const plantedTask = (withPlanted.body.data as Record<string, unknown>[]).find((entry) => entry.id === T_PLANTED.id);
  expect(plantedTask?.withheldFields).toEqual(['dueAt']);
  const plantedWeek = await call(cal('2026-09-27T23:00:00.000Z', '2026-10-04T23:00:00.000Z', '&limit=100'));
  const plantedMeeting = (plantedWeek.body.data as Record<string, unknown>[]).find((entry) => entry.id === M_PLANTED.id);
  expect(plantedMeeting?.withheldFields).toEqual(['startsAt', 'endsAt']);
  expect(plantedTimes.mockFaults).toEqual([]);
  for (const other of [mock, stale, honest, hostile, plantedTimes]) {
    expect(other.mockFaults).toEqual([]);
  }
});

// ===========================================================================
// The flag
// ===========================================================================

test.describe('crm_activities gates /activities', () => {
  // The flag-off tests PASS BEFORE THE WORK STARTS: there is no route, so
  // `/activities` is a 404 everywhere. A negative invariant, legitimately
  // vacuous until the screen exists; the flag-on test gives the pair meaning.
  test('/activities is a real 404 with every flag at its default, and nothing reaches the API @p07 @p07-flag-off', async ({ page }) => {
    const { webUrl } = stack();
    const mock = await installActivitiesMock(page);
    const response = await page.goto(`${webUrl}/activities`);
    expect(response?.status(), '/activities is reachable with crm_activities off').toBe(404);
    await expect(page.locator(SCREEN)).toHaveCount(0);
    expect(mock.requests.filter((url) => url.pathname.startsWith('/api/v1/me/')), 'a flag-off page still read activities').toEqual([]);
  });

  test('/activities cannot be switched on by anything the browser sends @p07 @p07-flag-off', async ({ browser }) => {
    const { webUrl } = stack();
    const context = await browser.newContext({
      extraHTTPHeaders: {
        'x-kasuwa-feature-flags': 'crm_activities,crm_records',
        'x-crm-activities': '1',
        'x-kasuwa-tenant-id': TENANT_A,
      },
    });
    await context.addCookies([
      { name: 'crm_activities', value: 'on', url: webUrl },
      { name: 'kasuwa_flags', value: 'crm_activities', url: webUrl },
    ]);
    const page = await context.newPage();
    for (const path of ['/activities?crm_activities=on&flags=crm_activities', '/activities/', '/activities?locale=en-XA']) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} was switched on from the browser`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    await context.close();
  });

  test('/activities renders My tasks with crm_activities on @p07 @p07-flag-on', async ({ page }) => {
    await openActivities(page);
    await expect(shown(screen(page).getByTestId('my-tasks')).first()).toBeVisible();
    await bucketsSettled(page);
  });
});

// ===========================================================================
// The shell
// ===========================================================================

test('/activities sits in the CRM shell, its nav marks Activities current, and no link on it is a 404 @p07 @p07-shell', async ({ page }) => {
  await openActivities(page);
  await bucketsSettled(page);
  const shell = page.locator('[data-shell="crm"]');
  await expect(shell).toBeVisible();
  await expect(shell.locator(SCREEN)).toBeVisible();
  await expect(shown(shell.locator('nav a[href="/activities"]')).first()).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('settings-menu')).toHaveCount(0);

  const links = async () => page.locator('a[href^="/"]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
  const tasksLinks = await links();
  await openCalendar(page);
  const calendarLinks = await links();
  const hrefs = [...new Set([...tasksLinks, ...calendarLinks])];
  expect(hrefs.length, 'the page links nowhere — not even the CRM nav').toBeGreaterThan(0);
  for (const href of hrefs) {
    expect(href, 'a link leads to the Map, which is a 501').not.toMatch(/\/accounts\/map\b/);
    const response = await page.request.get(`${activitiesUrl()}${href}`);
    expect(response.status(), `the page links to ${href}, which is a 404`).not.toBe(404);
  }
});

// ===========================================================================
// P07/01 — My tasks, by bucket
// ===========================================================================

test.describe('P07/01 — My tasks', () => {
  test('three buckets in order, each read once in the browser’s zone, rows in served order, named not counted, axe-clean @p07 @p07-buckets', async ({
    page,
  }) => {
    const mock = await openActivities(page);
    await bucketsSettled(page);
    const order = await shown(screen(page).locator('[data-testid="my-tasks"] [data-bucket]')).evaluateAll((groups) =>
      groups.map((element) => element.getAttribute('data-bucket') ?? ''),
    );
    expect(order, 'the buckets are not overdue, today, upcoming').toEqual(['overdue', 'today', 'upcoming']);

    for (const name of BUCKETS as Bucket[]) {
      const reads = mock.bucketReads.filter((url) => url.searchParams.get('bucket') === name);
      expect(reads, `the ${name} bucket was not read exactly once`).toHaveLength(1);
      expect(reads[0]?.searchParams.get('timeZone'), 'timeZone is not the browser’s zone').toBe(LAGOS);
      expect(reads[0]?.searchParams.has('cursor')).toBe(false);
      expect(await bucketIds(page, name), `the ${name} bucket is not the served page, in order`).toEqual(
        EXPECTED_BUCKETS[LAGOS][name].map((entry) => entry.id),
      );
      await expectSaysOneOf(bucket(page, name), labelsEndingWith(`.bucket.${name}`), `the ${name} bucket`);
      expect(await bucketChrome(page, name), `the ${name} bucket draws a count (D-P13)`).not.toMatch(/\d/);
    }

    // A row: its subject, its due time in the browser's zone, its summary by name.
    const emeka = row(page, T_EMEKA.id);
    await expect(emeka).toHaveAttribute('data-activity-type', 'task');
    await expect(emeka.locator('[data-field="subject"]').first()).toContainText(String(T_EMEKA.subject));
    const due = emeka.locator('[data-field="dueAt"]').first();
    const instants = await due.locator('time[datetime]').evaluateAll((times) => times.map((time) => Date.parse(time.getAttribute('datetime') ?? '')));
    expect(instants, 'the due time is not a <time datetime>').toContain(Date.parse(String(T_EMEKA.dueAt)));
    // Due 11:00Z is 12:00 in Lagos.
    expect(await visibleText(due), 'the due time is not shown in the browser’s zone').toMatch(clockPattern(String(T_EMEKA.dueAt), LAGOS));
    expect(await visibleText(due), 'the due time is shown in UTC').not.toMatch(/(?<!\d)11[:.]00(?!\d)/);
    await expect(emeka.locator('[data-related="contact"]').first()).toContainText(EMEKA.displayName);
    await expect(row(page, T_KWARA.id).locator('[data-related="account"]').first()).toContainText(String(T_KWARA.account?.name));
    await expect(row(page, T_NEXT_WEEK.id).locator('[data-related="account"]').first()).toContainText(UBUNTU.name);
    // An undated task says so, with no time and no lock.
    const undated = row(page, T_UNDATED.id).locator('[data-field="dueAt"]').first();
    await expect(undated).not.toHaveAttribute('data-locked', 'true');
    await expect(undated.locator('time')).toHaveCount(0);
    expect(await visibleText(undated), 'an undated task draws nothing where its due time would be').not.toBe('');

    // Every open task has its controls; nothing names a meeting, a note or a call.
    for (const entry of EXPECTED_BUCKETS[LAGOS].overdue) {
      await expect(shown(row(page, entry.id).locator('[data-action="complete-task"]')).first()).toBeVisible();
      await expect(shown(row(page, entry.id).locator('[data-action="snooze"]')).first()).toBeVisible();
    }
    await expect(screen(page).locator('[data-testid="my-tasks"] [data-activity-type]:not([data-activity-type="task"])')).toHaveCount(0);

    const raw = await visibleText(shown(screen(page).getByTestId('my-tasks')).first());
    expect(raw, 'raw values leaked into the list').not.toMatch(/\bnull\b|\bundefined\b|\[object Object\]/);
    expect(raw, 'a raw timestamp was printed').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(await page.title(), 'a task subject is in the document title').not.toContain(String(T_EMEKA.subject));
    await expectNoIdsAnywhere(page, 'My tasks');
    await expectNoSeriousAxe(page, 'P07/01');
  });

  test('a subject with markup in it is drawn as text, never parsed @p07 @p07-markup', async ({ page }) => {
    await openActivities(page);
    await bucketsSettled(page);
    const hostile = row(page, T_HOSTILE.id);
    await expect(hostile).toContainText('<b>Bùkọ́lá</b>');
    await expect(hostile).toContainText('about the deposit');
    await expect(screen(page).locator('[onerror], script, b:text-is("Bùkọ́lá")')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __kasuwaXss?: number }).__kasuwaXss)).toBeUndefined();
    expect(HOSTILE_SUBJECT).toContain('onerror');
  });

  test('a bucket pages by keyset "more", echoes the cursor exactly, keeps it out of the URL, and shows no count @p07 @p07-paging', async ({
    page,
  }) => {
    const mock = await openActivities(page, { longUpcoming: true });
    await bucketsSettled(page);
    const served = bucketRows(mock.store, 'upcoming', LAGOS);
    expect(served.length).toBeGreaterThan(100);
    const first = mock.bucketReads.find((url) => url.searchParams.get('bucket') === 'upcoming');
    const limit = Number(first?.searchParams.get('limit') ?? 25);
    await expect.poll(() => bucketIds(page, 'upcoming'), { message: 'the first page is not what was served' }).toEqual(
      served.slice(0, limit).map((entry) => entry.id),
    );

    let pages = 1;
    for (;;) {
      const more = shown(bucket(page, 'upcoming').locator('[data-testid="bucket-more"]'));
      if ((await more.count()) === 0 || (await isDisabled(more.first()))) break;
      expect(pages, '"more" never stops').toBeLessThanOrEqual(LONG_UPCOMING_LENGTH);
      const previous = mock.bucketReads.filter((url) => url.searchParams.get('bucket') === 'upcoming').length;
      const drawn = (await bucketIds(page, 'upcoming')).length;
      const answered = page.waitForResponse((response) => isBucketRead(response.request(), 'upcoming') && new URL(response.url()).searchParams.has('cursor'));
      await more.first().click();
      await answered;
      const sent = mock.bucketReads.filter((url) => url.searchParams.get('bucket') === 'upcoming')[previous];
      expect(sent?.searchParams.get('timeZone'), 'a later page changed the zone').toBe(LAGOS);
      expect(page.url(), 'the cursor was written into the page URL').not.toMatch(/[?&]cursor=/);
      pages += 1;
      // The page is drawn before "more" is judged again (it may be disabled while loading).
      await expect.poll(async () => (await bucketIds(page, 'upcoming')).length, { message: 'a page was read and not drawn' }).toBeGreaterThan(drawn);
    }
    expect(pages, 'the bucket was never paged').toBeGreaterThan(1);
    await expect.poll(() => bucketIds(page, 'upcoming'), { message: '"more" dropped, repeated or reordered tasks' }).toEqual(served.map((entry) => entry.id));
    // Echoed exactly: every cursor sent is one the previous answer served (the mock refuses any other).
    for (const name of ['overdue', 'today'] as const) {
      expect(mock.bucketReads.filter((url) => url.searchParams.get('bucket') === name), `paging re-read the ${name} bucket`).toHaveLength(1);
    }
    expect(await bucketChrome(page, 'upcoming'), 'a count was drawn').not.toMatch(/\d/);
    const text = await visibleText(screen(page));
    expect(text, 'a total was drawn').not.toMatch(new RegExp(`(?<!\\d)${served.length}(?!\\d)|\\b\\d+\\s+of\\s+\\d+\\b`, 'i'));
  });
});

// ===========================================================================
// Three zones (the zone is the browser's, never the server's guess)
// ===========================================================================

for (const zone of ZONES) {
  test.describe(`in ${zone}`, () => {
    test.use({ timezoneId: zone });

    test(`${zone}: buckets, times, the week and the reschedule form are all in the browser’s zone @p07 @p07-zones`, async ({ page }) => {
      const mock = await openActivities(page, { zone });
      await bucketsSettled(page);
      expect(mock.bucketReads.length, 'fewer than three bucket reads').toBeGreaterThanOrEqual(3);
      for (const url of mock.bucketReads) {
        expect(url.searchParams.get('timeZone'), 'timeZone is not the browser’s resolved zone').toBe(zone);
      }
      for (const name of BUCKETS as Bucket[]) {
        expect(await bucketIds(page, name), `${zone}: the ${name} bucket`).toEqual(EXPECTED_BUCKETS[zone][name].map((entry) => entry.id));
      }
      // T_SPLIT is due 20:00Z: 21:00 in Lagos, 22:00 in Johannesburg, 23:00 in Nairobi.
      const split = await visibleText(row(page, T_SPLIT.id).locator('[data-field="dueAt"]').first());
      expect(split, `${zone}: the due time is not local`).toMatch(clockPattern(String(T_SPLIT.dueAt), zone));
      for (const other of ZONES.filter((candidate) => candidate !== zone)) {
        expect(split, `${zone}: the due time is shown in ${other}`).not.toMatch(clockPattern(String(T_SPLIT.dueAt), other));
      }
      // The design's "always WAT" is the browser's zone here.
      const copy = await copyText(screen(page));
      for (const other of ZONES.filter((candidate) => candidate !== zone)) {
        expect(copy, `${zone}: the screen names another zone (${other})`).not.toMatch(ZONE_WORDS[other]);
      }

      // The reschedule form: prefilled in the zone, sent in UTC from the zone.
      const form = await rescheduleRow(page, T_NEXT_WEEK.id);
      await expect(input(form, 'dueAt')).toHaveAttribute('type', 'datetime-local');
      await expect(input(form, 'dueAt'), `${zone}: the form is not prefilled with the local due time`).toHaveValue(
        localInput(String(T_NEXT_WEEK.dueAt), zone),
      );
      await input(form, 'dueAt').fill('2026-10-06T09:00');
      const sent = page.waitForRequest((request) => isUpdateActivity(request, T_NEXT_WEEK.id));
      await shown(form.locator('[data-action="save-reschedule"]')).first().click();
      const body = json((await sent).postDataJSON());
      expect(keysOf(body)).toEqual(['dueAt', 'version']);
      expect(String(body.dueAt)).toMatch(/Z$/);
      expect(Date.parse(String(body.dueAt)), `${zone}: 09:00 local was not converted from the browser’s zone`).toBe(fromLocalInput('2026-10-06T09:00', zone));
      await expect(shown(page.getByTestId('reschedule-form'))).toHaveCount(0);

      // The week: local midnights, today marked, events on their local day.
      const first = await openCalendar(page);
      const window = windowOf(new URL(first.url()));
      expect(isLocalMidnight(window.from, zone), `${zone}: the week does not start at a local midnight`).toBe(true);
      expect(window.to - window.from, `${zone}: the week is not seven days`).toBe(7 * DAY);
      expect(window.from <= NOW_MS && NOW_MS < window.to, `${zone}: the week does not contain today`).toBe(true);
      await expect(shown(calendar(page).locator(`[data-calendar-day="${localDate(NOW, zone)}"]`)).first()).toHaveAttribute('aria-current', 'date');
      await expect(shown(calendar(page).locator('[data-calendar-day][aria-current="date"]'))).toHaveCount(1);
      await expect(events(page, M_LATE.id).first()).toBeVisible();
      expect(await dayOfEvent(page, M_LATE.id), `${zone}: the late meeting is not on its local day`).toContain(localDate(String(M_LATE.startsAt), zone));
    });
  });
}

// ===========================================================================
// P07/03–04 — the calendar
// ===========================================================================

test.describe('P07/03–04 — the calendar', () => {
  test('the week: one seven-day window from a local midnight, Kasuwa events on their local day, meetings with both times @p07 @p07-calendar-week', async ({
    page,
  }) => {
    const mock = await openActivities(page);
    await bucketsSettled(page);
    const first = await openCalendar(page);
    await expect(calendar(page)).toHaveAttribute('data-range', 'week');
    const url = new URL(first.url());
    expect([...new Set(url.searchParams.keys())].sort(), 'listCalendar was sent more than its window').toEqual(
      expect.arrayContaining(['from', 'to']),
    );
    const { from, to } = windowOf(url);
    expect(isLocalMidnight(from, LAGOS) && isLocalMidnight(to, LAGOS), 'the window is not local midnights').toBe(true);
    expect(to - from).toBe(7 * DAY);
    expect(from <= NOW_MS && NOW_MS < to).toBe(true);
    for (let day = 0; day < 7; day += 1) {
      await expect(shown(calendar(page).locator(`[data-calendar-day="${localDate(from + day * DAY, LAGOS)}"]`)).first()).toBeVisible();
    }
    await expect(shown(calendar(page).locator('[data-calendar-day="2026-09-30"]')).first()).toHaveAttribute('aria-current', 'date');

    const listed = expectedInWindow(baseActivities(), from, to);
    expect(listed.length).toBeGreaterThan(8);
    for (const entry of listed) {
      const event = events(page, entry.id).first();
      await expect(event, `${entry.id} is not on the calendar`).toBeVisible();
      await expect(event).toHaveAttribute('data-activity-type', entry.type);
      const start = String(entry.type === 'task' ? entry.dueAt : entry.startsAt);
      const instants = await events(page, entry.id).locator('time[datetime]').evaluateAll((times) =>
        times.map((time) => Date.parse(time.getAttribute('datetime') ?? '')),
      );
      expect(instants, `${entry.id} draws no <time datetime> for its start`).toContain(Date.parse(start));
      if (entry.type === 'meeting') {
        // A meeting spans its times: both are drawn.
        expect(instants, `${entry.id} draws no <time datetime> for its end`).toContain(Date.parse(String(entry.endsAt)));
      }
      if (Date.parse(start) >= from) {
        const days = await dayOfEvent(page, entry.id);
        expect(days, `${entry.id} is not on its local day`).toContain(localDate(start, LAGOS));
        expect(days.filter((day) => day !== '' && day < localDate(start, LAGOS)), `${entry.id} is drawn before it starts`).toEqual([]);
      }
    }
    // 14:30Z–15:30Z is 15:30–16:30 in Lagos; the task example is due 14:00Z, 15:00 in Lagos.
    const qbr = await visibleText(events(page, M_QBR.id).first());
    expect(qbr).toMatch(clockPattern(String(M_QBR.startsAt), LAGOS));
    expect(qbr, 'a meeting does not say when it ends').toMatch(clockPattern(String(M_QBR.endsAt), LAGOS));
    expect(await visibleText(events(page, T_QBR_DECK.id).first())).toMatch(clockPattern(String(T_QBR_DECK.dueAt), LAGOS));
    // Completion is shown, never undone; an open task can be completed.
    await expect(events(page, T_DONE.id).first()).toHaveAttribute('data-completed', 'true');
    await expectNoUsable(events(page, T_DONE.id).locator('[data-action="complete-task"]'), 'complete on a completed task');
    await expect(events(page, T_QBR_DECK.id).first()).toHaveAttribute('data-completed', 'false');
    // Only what was served: no undated task, nothing from next week, nothing invented.
    for (const absent of [T_UNDATED, T_NEXT_WEEK, M_SEPT, M_OCT]) {
      await expect(events(page, absent.id), `${absent.id} is drawn in a week it is not in`).toHaveCount(0);
    }
    const drawn = await shown(calendar(page).locator('[data-calendar-event]')).evaluateAll((all) =>
      all.map((element) => element.getAttribute('data-calendar-event') ?? ''),
    );
    expect([...new Set(drawn)].filter((id) => !listed.some((entry) => entry.id === id)), 'an event nobody served is drawn').toEqual([]);
    // Kasuwa events only (D-P22).
    expect(await copyText(calendar(page)), 'an external calendar or a holiday is drawn').not.toMatch(
      /google|microsoft|outlook|\bteams\b|holiday|independence/i,
    );
    expect(mock.calendarReads.every((read) => windowOf(read).to - windowOf(read).from <= MAX_WINDOW_MS)).toBe(true);
    await expectNoIdsAnywhere(page, 'the week');
    await expectNoSeriousAxe(page, 'P07/03');
  });

  test('the month covers the whole local month in one window of at most 42 days, and paging months never exceeds it @p07 @p07-calendar-month', async ({
    page,
  }) => {
    const mock = await openActivities(page);
    await bucketsSettled(page);
    await openCalendar(page);
    const covers = (start: string, end: string) => (response: Response) => {
      if (!isCalendarRead(response.request())) return false;
      const { from, to } = windowOf(new URL(response.url()));
      return from <= Date.parse(start) && to >= Date.parse(end);
    };
    const month = async (action: string, start: string, end: string): Promise<{ from: number; to: number }> => {
      const read = page.waitForResponse(covers(start, end));
      await shown(calendar(page).locator(`[data-action="${action}"]`).or(screen(page).locator(`[data-action="${action}"]`))).first().click();
      const window = windowOf(new URL((await read).url()));
      expect(window.to - window.from, `${action}: the window is over 42 days`).toBeLessThanOrEqual(MAX_WINDOW_MS);
      expect(isLocalMidnight(window.from, LAGOS) && isLocalMidnight(window.to, LAGOS), `${action}: not local midnights`).toBe(true);
      await expect(calendar(page)).toHaveAttribute('data-range', 'month');
      return window;
    };
    // September in Lagos: 1 September 00:00 WAT is 31 August 23:00Z.
    await month('calendar-month', '2026-08-31T23:00:00.000Z', '2026-09-30T23:00:00.000Z');
    for (let day = 1; day <= 30; day += 1) {
      await expect(shown(calendar(page).locator(`[data-calendar-day="2026-09-${String(day).padStart(2, '0')}"]`)).first()).toBeVisible();
    }
    await expect(shown(calendar(page).locator('[data-calendar-day="2026-09-30"]')).first()).toHaveAttribute('aria-current', 'date');
    await expect(events(page, M_SEPT.id).first()).toBeVisible();
    expect(await dayOfEvent(page, M_SEPT.id)).toContain('2026-09-10');
    await expect(events(page, M_OCT.id), 'October is drawn in September’s month').toHaveCount(0);

    await month('calendar-next', '2026-09-30T23:00:00.000Z', '2026-10-31T23:00:00.000Z');
    await expect(events(page, M_OCT.id).first()).toBeVisible();
    expect(await dayOfEvent(page, M_OCT.id)).toContain('2026-10-20');
    await month('calendar-prev', '2026-08-31T23:00:00.000Z', '2026-09-30T23:00:00.000Z');
    await month('calendar-prev', '2026-07-31T23:00:00.000Z', '2026-08-31T23:00:00.000Z');
    await expect(events(page, M_SEPT.id), 'September is drawn in August’s month').toHaveCount(0);

    // Back to today, and back to the week.
    const today = page.waitForResponse((response) => isCalendarRead(response.request()) && windowOf(new URL(response.url())).from <= NOW_MS && windowOf(new URL(response.url())).to > NOW_MS);
    await shown(calendar(page).locator('[data-action="calendar-today"]').or(screen(page).locator('[data-action="calendar-today"]'))).first().click();
    await today;
    const week = page.waitForResponse((response) => isCalendarRead(response.request()) && windowOf(new URL(response.url())).to - windowOf(new URL(response.url())).from === 7 * DAY);
    await shown(calendar(page).locator('[data-action="calendar-week"]').or(screen(page).locator('[data-action="calendar-week"]'))).first().click();
    const back = windowOf(new URL((await week).url()));
    expect(back.from <= NOW_MS && NOW_MS < back.to, 'the week after "today" does not contain today').toBe(true);
    for (const read of mock.calendarReads) {
      const { from, to } = windowOf(read);
      expect(to - from, `a request asked for ${((to - from) / DAY).toFixed(2)} days`).toBeLessThanOrEqual(MAX_WINDOW_MS);
    }
  });

  test('a busy week is read to its last page, every cursor echoed for the same window, nothing dropped @p07 @p07-calendar-paging', async ({ page }) => {
    const mock = await openActivities(page, { busyWeek: true });
    await bucketsSettled(page);
    // In the order the answers arrived (the pages are read one after another).
    const replies: { url: URL; body: Promise<unknown> }[] = [];
    page.on('response', (response) => {
      if (isCalendarRead(response.request()) && response.status() === 200) {
        replies.push({ url: new URL(response.url()), body: response.json() as Promise<unknown> });
      }
    });
    const first = await openCalendar(page);
    const { from, to } = windowOf(new URL(first.url()));
    const listed = calendarRows(mock.store, new Date(from).toISOString(), new Date(to).toISOString());
    expect(listed.length).toBeGreaterThan(BUSY_WEEK_LENGTH);
    // In the DOM, not necessarily on screen: a crowded hour may scroll. Never left unread.
    await expect
      .poll(async () => new Set(await calendar(page).locator('[data-calendar-event]').evaluateAll((all) => all.map((element) => element.getAttribute('data-calendar-event') ?? ''))).size, {
        message: 'the calendar did not draw every event of a window with more than one page',
      })
      .toBe(listed.length);
    const answers = await Promise.all(
      replies.map(async (reply) => ({ url: reply.url, nextCursor: ((await reply.body) as { nextCursor: string | null }).nextCursor })),
    );
    expect(answers.at(-1)?.nextCursor, 'the last page was never read').toBeNull();
    expect(answers.length, 'a window with more than 100 items was read in one page').toBeGreaterThan(1);
    for (let index = 1; index < answers.length; index += 1) {
      const sent = answers[index]?.url;
      expect(sent?.searchParams.get('cursor'), 'a cursor was not echoed exactly').toBe(answers[index - 1]?.nextCursor);
      expect(windowOf(sent ?? new URL(first.url()))).toEqual({ from, to });
    }
    expect(page.url()).not.toMatch(/[?&]cursor=/);
    expect(await copyText(calendar(page)), 'a count was drawn').not.toMatch(new RegExp(`(?<!\\d)(${BUSY_WEEK_LENGTH}|${listed.length})(?!\\d)`));
  });
});

// ===========================================================================
// P07/07 — the composer
// ===========================================================================

test.describe('P07/07 — composing a task or a meeting', () => {
  test('a task: one contact picked by name, its due time in UTC from the browser’s zone, owned by the caller @p07 @p07-compose-task', async ({
    page,
  }) => {
    const mock = await openActivities(page);
    await bucketsSettled(page);
    const composer = await openComposer(page, 'task');
    await expectNoUsable(composer.locator('[data-field-input="startsAt"], [data-field-input="endsAt"]'), 'a meeting time on a task');
    await input(composer, 'subject').fill('Send the delivery note');
    await pickTarget(page, composer, 'Adaeze', PICK_CONTACT.id, 'contact');
    expect(mock.pickerReads.some((url) => url.pathname === '/api/v1/contacts' && url.searchParams.get('q') === 'Adaeze'), 'the picker did not search contacts by the typed name').toBe(true);
    const due = input(composer, 'dueAt');
    await expect(due).toHaveAttribute('type', 'datetime-local');
    // 09:30 on a Lagos desk is 08:30 UTC.
    await due.fill('2026-10-01T09:30');
    const save = shown(composer.locator('[data-action="save-activity"]')).first();
    await expect(save).toHaveAttribute('data-requires-connection', /.*/);
    const posted = page.waitForRequest(isCreateActivity);
    await save.click();
    const body = json((await posted).postDataJSON());
    expect(body.type).toBe('task');
    expect(body.subject).toBe('Send the delivery note');
    expect(String(body.dueAt), 'the due time is not UTC with a Z').toMatch(/Z$/);
    expect(Date.parse(String(body.dueAt))).toBe(Date.parse('2026-10-01T08:30:00.000Z'));
    expect(body.contactId).toBe(PICK_CONTACT.id);
    expect(absentOrNull(body, 'accountId'), 'a task on a contact also named an account').toBe(true);
    expect(body.ownerUserId, 'the owner is not the caller').toBe(ME.id);
    expect('startsAt' in body || 'endsAt' in body, 'a task carried meeting times').toBe(false);
    await expect(shown(page.getByTestId('activity-composer'))).toHaveCount(0);
    // 08:30Z on 1 October is after Lagos' midnight: upcoming.
    await expect.poll(() => whereIs(page, NEW_ACTIVITY_IDS[0] ?? 'missing'), { message: 'the new task is not in its bucket' }).toBe('upcoming');
    expect(mock.writes, 'the task was created more than once').toHaveLength(1);
    await expectNoIdsAnywhere(page, 'after composing');
  });

  test('a meeting: one account picked by name, both times in UTC, owned by the caller, and on the calendar after @p07 @p07-compose-meeting', async ({
    page,
  }) => {
    const mock = await openActivities(page);
    await bucketsSettled(page);
    await openCalendar(page);
    const composer = await openComposer(page, 'meeting');
    await expectNoUsable(composer.locator('[data-field-input="dueAt"]'), 'a due time on a meeting');
    await input(composer, 'subject').fill('Pricing review');
    await pickTarget(page, composer, 'Foods', PICK_ACCOUNT.id, 'account');
    expect(mock.pickerReads.some((url) => url.pathname === '/api/v1/accounts'), 'the picker never searched accounts').toBe(true);
    await expect(input(composer, 'startsAt')).toHaveAttribute('type', 'datetime-local');
    await expect(input(composer, 'endsAt')).toHaveAttribute('type', 'datetime-local');
    await input(composer, 'startsAt').fill('2026-10-02T14:00');
    await input(composer, 'endsAt').fill('2026-10-02T15:00');
    const posted = page.waitForRequest(isCreateActivity);
    await shown(composer.locator('[data-action="save-activity"]')).first().click();
    const body = json((await posted).postDataJSON());
    expect(body.type).toBe('meeting');
    expect(Date.parse(String(body.startsAt))).toBe(Date.parse('2026-10-02T13:00:00.000Z'));
    expect(Date.parse(String(body.endsAt))).toBe(Date.parse('2026-10-02T14:00:00.000Z'));
    expect(String(body.startsAt)).toMatch(/Z$/);
    expect(String(body.endsAt)).toMatch(/Z$/);
    expect(body.accountId).toBe(PICK_ACCOUNT.id);
    expect(absentOrNull(body, 'contactId')).toBe(true);
    expect(absentOrNull(body, 'dueAt'), 'a meeting carried a due time').toBe(true);
    expect(body.ownerUserId, 'the meeting is not on the caller’s calendar').toBe(ME.id);
    await expect(shown(page.getByTestId('activity-composer'))).toHaveCount(0);
    await expect(events(page, NEW_ACTIVITY_IDS[0] ?? 'missing').first(), 'the new meeting is not on the calendar').toBeVisible();
    expect(await dayOfEvent(page, NEW_ACTIVITY_IDS[0] ?? 'missing')).toContain('2026-10-02');
    expect(mock.writes).toHaveLength(1);
  });

  test('a meeting with a missing time, an end at or before its start, or over 24 hours is a translated message and sends nothing @p07 @p07-compose-validation', async ({
    page,
  }) => {
    const mock = await openActivities(page);
    await bucketsSettled(page);
    const composer = await openComposer(page, 'meeting');
    await input(composer, 'subject').fill('Quarterly review');
    await pickTarget(page, composer, 'Foods', PICK_ACCOUNT.id, 'account');
    const save = shown(composer.locator('[data-action="save-activity"]')).first();
    const fieldError = (name: string) => shown(composer.locator(`[data-field-error="${name}"]`)).first();
    const said: string[] = [];

    // Both times are required.
    await input(composer, 'startsAt').fill('2026-10-02T14:00');
    await input(composer, 'endsAt').fill('');
    await save.click();
    await expect(fieldError('endsAt'), 'a missing end says nothing').toBeVisible();
    await expectSaysOneOf(fieldError('endsAt'), meetingRuleLabels('required', 'Required', 'endsRequired', 'endRequired'), 'a missing end');
    said.push(await visibleText(fieldError('endsAt')));

    // The end must be after the start; equal is not after.
    for (const end of ['2026-10-02T13:00', '2026-10-02T14:00']) {
      await input(composer, 'endsAt').fill(end);
      await save.click();
      await expect(fieldError('endsAt'), `an end at ${end} says nothing`).toBeVisible();
      await expectSaysOneOf(fieldError('endsAt'), meetingRuleLabels('invalid_range', 'invalidRange'), `an end at ${end}`);
    }
    said.push(await visibleText(fieldError('endsAt')));

    // At most 24 hours.
    await input(composer, 'endsAt').fill('2026-10-03T14:30');
    await save.click();
    await expect(fieldError('endsAt')).toBeVisible();
    await expectSaysOneOf(fieldError('endsAt'), meetingRuleLabels('too_long', 'tooLong'), 'a meeting over 24 hours');
    said.push(await visibleText(fieldError('endsAt')));
    expect(new Set(said).size, 'the three rules share one message').toBe(3);
    await expect(composer, 'the composer closed on a refused meeting').toBeVisible();

    // Exactly 24 hours is allowed, and it is the only thing that was ever sent.
    await input(composer, 'endsAt').fill('2026-10-03T14:00');
    const posted = page.waitForRequest(isCreateActivity);
    await save.click();
    const body = json((await posted).postDataJSON());
    expect(Date.parse(String(body.endsAt)) - Date.parse(String(body.startsAt))).toBe(DAY);
    expect(mock.writes, 'a refused meeting was sent').toHaveLength(1);
    await expect(shown(composer.locator('[data-field-error]'))).toHaveCount(0);
  });
});

// ===========================================================================
// Completing, snoozing and rescheduling (updateActivity)
// ===========================================================================

test.describe('P07/01, P07/03 — complete, snooze, reschedule', () => {
  test('completing sends exactly { version, completed }, is not optimistic, takes the task out of its bucket, and offers no Undo @p07 @p07-complete', async ({
    page,
  }) => {
    const mock = await openActivities(page, { holdWrites: true });
    await bucketsSettled(page);
    const complete = shown(row(page, T_EMEKA.id).locator('[data-action="complete-task"]')).first();
    await expect(complete).toHaveAttribute('data-requires-connection', /.*/);
    const patched = page.waitForRequest((request) => isUpdateActivity(request, T_EMEKA.id));
    await complete.click();
    const body = json((await patched).postDataJSON());
    expect(body).toEqual({ version: T_EMEKA.version, completed: true });
    // Held: nothing optimistic. The task is still where the server last put it.
    expect(await bucketIds(page, 'overdue'), 'the task left its bucket before the server answered').toContain(T_EMEKA.id);
    mock.releaseWrites();
    await expect.poll(() => whereIs(page, T_EMEKA.id), { message: 'a completed task is still listed as open' }).toBe('nowhere');
    expect(mock.writes.map((write) => write.status)).toEqual([200]);
    // No reopening (D-L81): no Undo, anywhere.
    await expect(shown(page.locator('[data-action="undo"], [data-action="reopen"]'))).toHaveCount(0);
    expect(await copyText(page.locator('body')), 'Undo is offered').not.toMatch(/\bundo\b|\breopen\b/i);
  });

  test('a snooze preset sends exactly { version, dueAt } for a later time; the task lands in the bucket the server says @p07 @p07-snooze', async ({
    page,
  }) => {
    const mock = await openActivities(page);
    await bucketsSettled(page);
    const snooze = shown(row(page, T_SPLIT.id).locator('[data-action="snooze"]')).first();
    await expect(snooze).toHaveAttribute('data-requires-connection', /.*/);
    await snooze.click();
    const option = shown(page.locator('[data-testid="snooze-menu"] [data-snooze-option]')).first();
    await expect(option, 'the snooze menu offers no preset').toBeVisible();
    const patched = page.waitForRequest((request) => isUpdateActivity(request, T_SPLIT.id));
    await option.click();
    const body = json((await patched).postDataJSON());
    expect(keysOf(body), 'a snooze sent more than version and dueAt').toEqual(['dueAt', 'version']);
    expect(body.version).toBe(T_SPLIT.version);
    expect(String(body.dueAt)).toMatch(/Z$/);
    const snoozed = Date.parse(String(body.dueAt));
    expect(snoozed, 'a snooze moved the task into the past').toBeGreaterThan(NOW_MS);
    expect(snoozed, 'a snooze did not move the task').not.toBe(Date.parse(String(T_SPLIT.dueAt)));
    await expect.poll(() => whereIs(page, T_SPLIT.id), { message: 'the snoozed task is not in its new bucket' }).toBe(lagosBucketOf(String(body.dueAt)));

    // A chosen time: prefilled in the zone, sent once, only dueAt.
    const form = await rescheduleRow(page, T_LATE_TODAY.id);
    await expect(input(form, 'dueAt')).toHaveValue(localInput(String(T_LATE_TODAY.dueAt), LAGOS));
    await expect(shown(form.locator('[data-action="save-reschedule"]')).first()).toHaveAttribute('data-requires-connection', /.*/);
    await input(form, 'dueAt').fill('2026-10-03T09:00');
    const second = page.waitForRequest((request) => isUpdateActivity(request, T_LATE_TODAY.id));
    await shown(form.locator('[data-action="save-reschedule"]')).first().click();
    const moved = json((await second).postDataJSON());
    expect(keysOf(moved)).toEqual(['dueAt', 'version']);
    expect(moved.version).toBe(T_LATE_TODAY.version);
    expect(Date.parse(String(moved.dueAt))).toBe(Date.parse('2026-10-03T08:00:00.000Z'));
    await expect(shown(page.getByTestId('reschedule-form'))).toHaveCount(0);
    await expect.poll(() => whereIs(page, T_LATE_TODAY.id)).toBe('upcoming');
    expect(mock.writes.map((write) => write.status)).toEqual([200, 200]);
  });

  test('a meeting is resized with only endsAt and moved with only its times, from a form prefilled in the zone @p07 @p07-reschedule', async ({
    page,
  }) => {
    const mock = await openActivities(page);
    await bucketsSettled(page);
    await openCalendar(page);
    await eventAction(page, M_RESCHED.id, 'reschedule');
    let form = await rescheduleForm(page);
    await expect(input(form, 'startsAt')).toHaveValue('2026-10-02T10:00');
    await expect(input(form, 'endsAt')).toHaveValue('2026-10-02T11:00');
    await expectNoUsable(form.locator('[data-field-input="dueAt"]'), 'a due time on a meeting');
    await expectNoSeriousAxe(page, 'the reschedule form');

    // Resize: only the end changed, so only the end is sent.
    await input(form, 'endsAt').fill('2026-10-02T11:30');
    const resized = page.waitForRequest((request) => isUpdateActivity(request, M_RESCHED.id));
    await shown(form.locator('[data-action="save-reschedule"]')).first().click();
    const first = json((await resized).postDataJSON());
    expect(keysOf(first), 'a resize sent the start too').toEqual(['endsAt', 'version']);
    expect(first.version).toBe(M_RESCHED.version);
    expect(Date.parse(String(first.endsAt))).toBe(Date.parse('2026-10-02T10:30:00.000Z'));
    await expect(shown(page.getByTestId('reschedule-form'))).toHaveCount(0);
    await expect
      .poll(() => events(page, M_RESCHED.id).locator('time[datetime]').evaluateAll((times) => times.map((time) => Date.parse(time.getAttribute('datetime') ?? ''))))
      .toContain(Date.parse('2026-10-02T10:30:00.000Z'));

    // Move: both times, on the version the last answer served.
    await eventAction(page, M_RESCHED.id, 'reschedule');
    form = await rescheduleForm(page);
    await expect(input(form, 'endsAt')).toHaveValue('2026-10-02T11:30');
    await input(form, 'startsAt').fill('2026-10-02T13:00');
    await input(form, 'endsAt').fill('2026-10-02T14:30');
    const movedRequest = page.waitForRequest((request) => isUpdateActivity(request, M_RESCHED.id));
    await shown(form.locator('[data-action="save-reschedule"]')).first().click();
    const moved = json((await movedRequest).postDataJSON());
    expect(keysOf(moved)).toEqual(['endsAt', 'startsAt', 'version']);
    expect(moved.version, 'the move did not send the version the resize was answered with').toBe(M_RESCHED.version + 1);
    expect(Date.parse(String(moved.startsAt))).toBe(Date.parse('2026-10-02T12:00:00.000Z'));
    expect(Date.parse(String(moved.endsAt))).toBe(Date.parse('2026-10-02T13:30:00.000Z'));
    await expect(shown(page.getByTestId('reschedule-form'))).toHaveCount(0);

    // A bad reschedule is the form's message, and nothing goes out until it is fixed.
    await eventAction(page, M_RESCHED.id, 'reschedule');
    form = await rescheduleForm(page);
    await input(form, 'endsAt').fill('2026-10-02T12:00');
    await shown(form.locator('[data-action="save-reschedule"]')).first().click();
    const error = shown(form.locator('[data-field-error="endsAt"], [data-field-error="startsAt"]')).first();
    await expect(error, 'an end before the start says nothing').toBeVisible();
    await expectSaysOneOf(error, meetingRuleLabels('invalid_range', 'invalidRange'), 'an end before the start');
    await input(form, 'endsAt').fill('2026-10-02T15:00');
    const fixed = page.waitForRequest((request) => isUpdateActivity(request, M_RESCHED.id));
    await shown(form.locator('[data-action="save-reschedule"]')).first().click();
    const last = json((await fixed).postDataJSON());
    expect(keysOf(last), 'only the end was changed').toEqual(['endsAt', 'version']);
    expect(mock.writes.map((write) => write.status), 'a refused reschedule was sent').toEqual([200, 200, 200]);
  });

  test('two 409s in a row: the screen re-reads each time, rebases, and never sends the start the person did not touch @p07 @p07-stale', async ({
    page,
  }) => {
    const mock = await openActivities(page, {
      concurrent: {
        activityId: M_RESCHED.id,
        changes: [{ startsAt: '2026-10-02T08:30:00.000Z' }, { startsAt: '2026-10-02T08:00:00.000Z' }],
      },
    });
    await bucketsSettled(page);
    await openCalendar(page);
    await eventAction(page, M_RESCHED.id, 'reschedule');
    const form = await rescheduleForm(page);
    await input(form, 'endsAt').fill('2026-10-02T11:30');
    const save = () => shown(form.locator('[data-action="save-reschedule"]')).first();

    for (const [attempt, freshStart] of [
      [1, '2026-10-02T09:30'],
      [2, '2026-10-02T09:00'],
    ] as const) {
      const reads = mock.calendarReads.length;
      const answered = page.waitForResponse((response) => isUpdateActivity(response.request(), M_RESCHED.id));
      await save().click();
      expect((await answered).status(), `save ${attempt} was not beaten`).toBe(409);
      await expect(shown(form.getByRole('alert')).first(), `no alert for the 409 on save ${attempt}`).toBeVisible();
      // The screen re-reads by itself; then the form is the fresh row with the person's edit on top.
      await expect.poll(() => mock.calendarReads.length, { message: `no re-read after the 409 on save ${attempt}` }).toBeGreaterThan(reads);
      await expect(input(form, 'startsAt'), `the form kept the stale start after save ${attempt}`).toHaveValue(freshStart);
      await expect(input(form, 'endsAt'), 'the person’s typed end was lost').toHaveValue('2026-10-02T11:30');
      await expect(shown(form.locator('[data-conflict]')), 'a conflict was claimed for a field only one person changed').toHaveCount(0);
    }
    const won = page.waitForResponse((response) => isUpdateActivity(response.request(), M_RESCHED.id));
    await save().click();
    expect((await won).status()).toBe(200);
    const bodies = mock.writes.map((write) => json(write.body));
    expect(bodies.map(keysOf), 'a save after a 409 sent a field the person never touched').toEqual([
      ['endsAt', 'version'],
      ['endsAt', 'version'],
      ['endsAt', 'version'],
    ]);
    expect(bodies.map((body) => body.version)).toEqual([M_RESCHED.version, M_RESCHED.version + 1, M_RESCHED.version + 2]);
    expect(mock.writes.map((write) => write.status)).toEqual([409, 409, 200]);
    await expect(shown(page.getByTestId('reschedule-form'))).toHaveCount(0);
  });

  test('a field both people changed keeps what was typed, says someone else changed it, and the second save sends it on the fresh version @p07 @p07-stale', async ({
    page,
  }) => {
    const mock = await openActivities(page, {
      concurrent: { activityId: M_RESCHED.id, changes: [{ endsAt: '2026-10-02T10:15:00.000Z' }] },
    });
    await bucketsSettled(page);
    await openCalendar(page);
    await eventAction(page, M_RESCHED.id, 'reschedule');
    const form = await rescheduleForm(page);
    await input(form, 'endsAt').fill('2026-10-02T11:30');
    const reads = mock.calendarReads.length;
    const lost = page.waitForResponse((response) => isUpdateActivity(response.request(), M_RESCHED.id));
    await shown(form.locator('[data-action="save-reschedule"]')).first().click();
    expect((await lost).status()).toBe(409);
    await expect.poll(() => mock.calendarReads.length, { message: 'no re-read after the 409' }).toBeGreaterThan(reads);
    await expect(shown(form.locator('[data-conflict]')).first(), 'no "changed by someone else" note').toBeVisible();
    await expect(input(form, 'endsAt')).toHaveValue('2026-10-02T11:30');
    await expect(input(form, 'startsAt')).toHaveValue('2026-10-02T10:00');
    const second = page.waitForRequest((request) => isUpdateActivity(request, M_RESCHED.id));
    await shown(form.locator('[data-action="save-reschedule"]')).first().click();
    const body = json((await second).postDataJSON());
    expect(keysOf(body)).toEqual(['endsAt', 'version']);
    expect(body.version).toBe(M_RESCHED.version + 1);
    expect(Date.parse(String(body.endsAt))).toBe(Date.parse('2026-10-02T10:30:00.000Z'));
    await expect.poll(() => mock.writes.map((write) => write.status)).toEqual([409, 200]);
  });

  test('a stale snooze re-reads its bucket, keeps the typed time with a note, and sends it once more on the fresh version @p07 @p07-stale', async ({
    page,
  }) => {
    const mock = await openActivities(page, {
      concurrent: { activityId: T_SPLIT.id, changes: [{ dueAt: '2026-10-03T09:00:00.000Z' }] },
    });
    await bucketsSettled(page);
    const form = await rescheduleRow(page, T_SPLIT.id);
    await input(form, 'dueAt').fill('2026-10-04T10:00');
    const reads = mock.bucketReads.length;
    const lost = page.waitForResponse((response) => isUpdateActivity(response.request(), T_SPLIT.id));
    await shown(form.locator('[data-action="save-reschedule"]')).first().click();
    expect((await lost).status()).toBe(409);
    await expect.poll(() => mock.bucketReads.length, { message: 'no re-read after the 409' }).toBeGreaterThan(reads);
    for (const url of mock.bucketReads.slice(reads)) {
      expect(url.searchParams.get('timeZone'), 'the re-read dropped the zone').toBe(LAGOS);
    }
    await expect(shown(form.locator('[data-conflict]')).first()).toBeVisible();
    await expect(input(form, 'dueAt')).toHaveValue('2026-10-04T10:00');
    const second = page.waitForRequest((request) => isUpdateActivity(request, T_SPLIT.id));
    await shown(form.locator('[data-action="save-reschedule"]')).first().click();
    const body = json((await second).postDataJSON());
    expect(keysOf(body), 'the second save sent more than the typed time').toEqual(['dueAt', 'version']);
    expect(body.version, 'the second save did not use the re-read version').toBe(T_SPLIT.version + 1);
    expect(String(body.dueAt)).toMatch(/Z$/);
    expect(Date.parse(String(body.dueAt))).toBe(Date.parse('2026-10-04T09:00:00.000Z'));
    await expect.poll(() => mock.writes.map((write) => write.status)).toEqual([409, 200]);
  });

  test('a 403 field_not_editable is its own translated message, never retried, and the served time stays @p07 @p07-not-editable', async ({
    page,
  }) => {
    const mock = await openActivities(page);
    await bucketsSettled(page);
    await shown(row(page, T_KWARA.id).locator('[data-action="snooze"]')).first().click();
    const answered = page.waitForResponse((response) => isUpdateActivity(response.request(), T_KWARA.id));
    await shown(page.locator('[data-testid="snooze-menu"] [data-snooze-option]')).first().click();
    const response = await answered;
    expect(response.status()).toBe(403);
    expect(((await response.json()) as { details?: unknown }).details).toEqual([{ path: 'dueAt', code: 'field_not_editable' }]);
    const labels = labelsEndingWith('.field_not_editable', '.fieldNotEditable');
    const alert = shown(page.getByRole('alert')).filter({ hasText: new RegExp(labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '$^') });
    await expect(alert.first(), 'the refusal does not say the time cannot be changed').toBeVisible();
    expect(await visibleText(alert.first()), 'field_not_editable was shown as the generic refusal').not.toBe(EN['records.error.not_permitted']);
    // The served time stays where it was: 15:00Z is 16:00 in Lagos.
    expect(await bucketIds(page, 'overdue')).toContain(T_KWARA.id);
    expect(await visibleText(row(page, T_KWARA.id).locator('[data-field="dueAt"]').first())).toMatch(clockPattern(String(T_KWARA.dueAt), LAGOS));
    // A message, not a retry: a later round trip goes by, and still one write.
    await openCalendar(page);
    expect(mock.writes.map((write) => write.status), 'a field_not_editable refusal was retried').toEqual([403]);
  });
});

// ===========================================================================
// Field security: locks, never guesses
// ===========================================================================

test.describe('withheld fields and times', () => {
  test('a withheld subject, account link or completion is a lock, never blank and never a guess @p07 @p07-locked', async ({ page }) => {
    await openActivities(page);
    await bucketsSettled(page);
    const subject = row(page, T_KWARA.id).locator('[data-field="subject"]').first();
    await expect(subject, 'a withheld subject is not drawn at all').toBeVisible();
    await expect(subject).toHaveAttribute('data-locked', 'true');
    await expect(lockIcon(subject)).toHaveCount(1);
    expect(await visibleText(subject), 'a withheld subject is drawn as empty').not.toMatch(/^(|null|undefined|—|-|–)$/i);
    const related = row(page, T_P3_OPEN.id).locator('[data-related]').first();
    await expect(related, 'a withheld account link is not drawn at all').toBeVisible();
    await expect(related).toHaveAttribute('data-locked', 'true');
    await expect(lockIcon(related)).toHaveCount(1);
    await expect(related.locator('a')).toHaveCount(0);
    expect(await visibleText(row(page, T_P3_OPEN.id)), 'the withheld account was named').not.toContain(String(T_P3_OPEN.account?.name));

    await openCalendar(page);
    const done = events(page, T_DONE_LOCKED.id).first();
    await expect(done).toBeVisible();
    const state = await done.getAttribute('data-completed');
    expect(state === 'true' || state === 'false', 'a withheld completion was drawn as done or not done').toBe(false);
    await expect(lockIcon(done), 'a withheld completion is not a lock').not.toHaveCount(0);
    await expectNoUsable(done.locator('[data-action="complete-task"]'), 'complete on a task whose completion is withheld');
  });

  test('a time the server should never have listed withheld is still never guessed @p07 @p07-locked', async ({ page }) => {
    // The contract drops a task whose dueAt (or a meeting whose times) is
    // withheld. This journey breaks that promise on purpose: a screen that
    // trusts it draws "no due date" or a midnight slot, which is a lie.
    await openActivities(page, { plantWithheldTimes: true });
    await bucketsSettled(page);
    const planted = row(page, T_PLANTED.id).locator('[data-field="dueAt"]').first();
    await expect(planted).toBeVisible();
    await expect(planted).toHaveAttribute('data-locked', 'true');
    await expect(lockIcon(planted)).toHaveCount(1);
    await expect(planted.locator('time')).toHaveCount(0);
    const undated = await visibleText(row(page, T_UNDATED.id).locator('[data-field="dueAt"]').first());
    expect(await visibleText(planted), 'a withheld due time is drawn as "no due date"').not.toBe(undated);

    await openCalendar(page);
    const meeting = events(page, M_PLANTED.id);
    if ((await meeting.count()) > 0) {
      await expect(meeting.first()).toHaveAttribute('data-locked', 'true');
      await expect(meeting.first().locator('time[datetime]'), 'a withheld meeting time was drawn').toHaveCount(0);
      expect((await dayOfEvent(page, M_PLANTED.id)).filter((day) => day !== ''), 'a meeting with withheld times was placed on a day').toEqual([]);
    }
    // Not drawn at all is also honest (a legitimately vacuous branch).
  });
});

// ===========================================================================
// Links and ids
// ===========================================================================

test('a summary links only from a well-formed uuid, URL-encoded, to its record; anything else is text, and no id is printed @p07 @p07-links', async ({
  page,
}) => {
  const mock = await openActivities(page, { hostileSummaries: true });
  await bucketsSettled(page);
  expect(mock.plantedFaults.length, 'the hostile summaries were not served').toBeGreaterThanOrEqual(2);
  const contact = row(page, T_EMEKA.id).locator('[data-related="contact"] a[href]').first();
  await expect(contact, 'a contact summary with a uuid does not link').toHaveAttribute('href', `/contacts/${encodeURIComponent(EMEKA.id)}`);
  await expect(contact).toContainText(EMEKA.displayName);
  const account = row(page, T_KWARA.id).locator('[data-related="account"] a[href]').first();
  await expect(account).toHaveAttribute('href', `/accounts/${encodeURIComponent(String(T_KWARA.account?.id))}`);

  const hostile = row(page, T_HOSTILE_LINKS.id);
  await expect(hostile).toContainText('Ngozi Eze');
  await expect(hostile).toContainText('Ikeja Motors');
  await expect(hostile.locator('a'), 'a summary with a malformed id was linked').toHaveCount(0);
  const hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
  for (const href of hrefs) {
    expect(href, 'a link was built from a malformed id').not.toMatch(/javascript:|\.\.|admin\/audit|export=/i);
    expect(href).not.toContain(HOSTILE_CONTACT_ID);
    expect(href).not.toContain(HOSTILE_ACCOUNT_ID);
  }
  const related = await screen(page).locator('[data-related] a[href]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
  expect(related.length, 'no summary links at all').toBeGreaterThan(1);
  for (const href of related) {
    const [, kind, id] = /^\/(contacts|accounts)\/(.+)$/.exec(href) ?? [];
    expect(kind, `${href} is not a record link`).toBeDefined();
    expect(UUID_ONLY.test(decodeURIComponent(id ?? '')), `${href} links a malformed id`).toBe(true);
  }
  await expectNoIdsAnywhere(page, 'My tasks with hostile summaries');
});

// ===========================================================================
// Loading, empty and failed are three different things
// ===========================================================================

test.describe('states', () => {
  test('loading draws skeletons, never "nothing due" or an error, until the buckets arrive @p07 @p07-states', async ({ page }) => {
    const mock = await openActivities(page, { hold: true });
    try {
      expect(await shown(screen(page).locator('[data-testid="tasks-skeleton"], [data-testid="bucket-skeleton"]')).count(), 'no skeleton').toBeGreaterThan(0);
      await expect(screen(page).locator('[data-testid="tasks-empty"], [data-testid="bucket-empty"], [data-testid="bucket-error"], [data-activity]')).toHaveCount(0);
    } finally {
      mock.release();
    }
    await bucketsSettled(page);
    await expect(shown(screen(page).locator('[data-testid="tasks-skeleton"], [data-testid="bucket-skeleton"]'))).toHaveCount(0);
  });

  test('nothing owned is "all caught up" with no count; the calendar says it is empty, not broken @p07 @p07-states', async ({ page }) => {
    await openActivities(page, { empty: true });
    const empty = shown(screen(page).getByTestId('tasks-empty')).first();
    await expect(empty).toBeVisible();
    expect(await visibleText(empty)).not.toBe('');
    expect(await copyText(empty), 'the empty state draws a count or a stat (D-P13)').not.toMatch(/\d/);
    await expect(screen(page).locator('[data-testid="bucket-error"], [data-activity]')).toHaveCount(0);
    await openCalendar(page);
    await expect(shown(calendar(page).getByTestId('calendar-empty')).first()).toBeVisible();
    await expect(calendar(page).getByTestId('calendar-error')).toHaveCount(0);
    await expect(calendar(page).locator('[data-calendar-event]')).toHaveCount(0);
  });

  test('one failed bucket is an error in that bucket, never "nothing due", and the others still draw @p07 @p07-states', async ({ page }) => {
    await openActivities(page, { bucketFailure: 'today' });
    await bucketsSettled(page);
    await expect(shown(bucket(page, 'today').getByTestId('bucket-error')).first()).toBeVisible();
    await expect(bucket(page, 'today').getByTestId('bucket-empty'), '"nothing due today" for a read that failed').toHaveCount(0);
    expect(await bucketIds(page, 'overdue')).toEqual(EXPECTED_BUCKETS[LAGOS].overdue.map((entry) => entry.id));
    await expect(screen(page).getByTestId('tasks-empty')).toHaveCount(0);
  });

  test('a dropped connection fails every bucket and the calendar as errors, never as empty @p07 @p07-states', async ({ page }) => {
    await openActivities(page, { networkFailure: true });
    for (const name of BUCKETS as Bucket[]) {
      await expect(shown(bucket(page, name).getByTestId('bucket-error')).first(), `the ${name} bucket shows no error`).toBeVisible();
    }
    await expect(screen(page).locator('[data-testid="tasks-empty"], [data-testid="bucket-empty"]')).toHaveCount(0);
    await shown(screen(page).locator('[data-action="view-calendar"]')).first().click();
    await expect(shown(calendar(page).getByTestId('calendar-error')).first()).toBeVisible();
    await expect(calendar(page).getByTestId('calendar-empty')).toHaveCount(0);
  });

  test('the calendar loading is a skeleton, and a failed calendar read is an error, not an empty week @p07 @p07-states', async ({ page }) => {
    const mock = await openActivities(page, { calendarFailure: true });
    await bucketsSettled(page);
    await shown(screen(page).locator('[data-action="view-calendar"]')).first().click();
    await expect(shown(calendar(page).getByTestId('calendar-error')).first()).toBeVisible();
    await expect(calendar(page).getByTestId('calendar-empty')).toHaveCount(0);
    expect(mock.calendarReads.length).toBeGreaterThan(0);
    expect(mock.violations).toEqual([]);
    expect(mock.mockFaults).toEqual([]);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const held = await openActivities(page, { hold: true });
    try {
      await shown(screen(page).locator('[data-action="view-calendar"]')).first().click();
      await expect(shown(calendar(page).getByTestId('calendar-skeleton')).first()).toBeVisible();
      await expect(calendar(page).locator('[data-testid="calendar-empty"], [data-testid="calendar-error"], [data-calendar-event]')).toHaveCount(0);
    } finally {
      held.release();
    }
    await expect(events(page, M_QBR.id).first()).toBeVisible();
    await expect(shown(calendar(page).getByTestId('calendar-skeleton'))).toHaveCount(0);
  });
});

// ===========================================================================
// Offline (D-P21, D-L64)
// ===========================================================================

test('offline: every write is disabled, nothing is queued or sent, and nothing is kept on the device @p07 @p07-offline', async ({ page }) => {
  const mock = await openActivities(page);
  await bucketsSettled(page);
  for (const action of ['complete-task', 'snooze']) {
    await expect(shown(row(page, T_EMEKA.id).locator(`[data-action="${action}"]`)).first()).toHaveAttribute('data-requires-connection', /.*/);
  }
  await expect(shown(screen(page).locator('[data-action="compose"]')).first()).toHaveAttribute('data-requires-connection', /.*/);
  // A task being typed when the connection drops cannot be saved (D-P21: no queue).
  const composer = await openComposer(page, 'task');
  await input(composer, 'subject').fill('Typed before the line dropped');

  await page.context().setOffline(true);
  try {
    await expect(shown(composer.locator('[data-action="save-activity"]')).first()).toBeDisabled();
    const banner = shown(page.getByTestId('offline-banner')).first();
    await expect(banner).toBeVisible();
    expect(await visibleText(banner), 'the banner does not say when the list last synced').toMatch(/\d{1,2}[:.]\d{2}/);
    expect(await copyText(page.locator('body')), 'an offline queue is offered').not.toMatch(/queued|sync queue|will sync|saved on this (phone|device)/i);
    const needsConnection = page.locator('[data-requires-connection]');
    const count = await needsConnection.count();
    expect(count, 'nothing is marked as needing a connection').toBeGreaterThan(2);
    for (let index = 0; index < count; index += 1) {
      expect(await isDisabled(needsConnection.nth(index)), `a control that needs a connection is enabled offline (#${index})`).toBe(true);
    }
    expect(await bucketIds(page, 'overdue'), 'the list was dropped when the connection went').toEqual(EXPECTED_BUCKETS[LAGOS].overdue.map((entry) => entry.id));

    const stored = await deviceStorage(page);
    expect(stored.cachedApi, 'an API response was put in Cache Storage').toEqual([]);
    expect(stored.databases, 'an IndexedDB database was opened').toEqual([]);
    for (const needle of needles()) {
      expect(stored.dump.includes(needle), `"${needle}" was written to device storage`).toBe(false);
    }
    expect(stored.dump.includes('Typed before the line dropped'), 'a draft was kept on the device').toBe(false);
  } finally {
    await page.context().setOffline(false);
  }
  await expect(shown(page.getByTestId('offline-banner'))).toHaveCount(0);
  expect(mock.writes, 'a write was sent or queued while offline').toEqual([]);
});

// ===========================================================================
// Hidden until their modules exist (D-L105, D-P13, D-P21, D-P22)
// ===========================================================================

test('no priority, bulk, Undo, external calendars, holidays, AI brief, booking, check-in, attendees, reminders or counts @p07 @p07-hidden', async ({
  page,
}) => {
  await openActivities(page);
  await bucketsSettled(page);
  const banned: readonly (readonly [RegExp, string])[] = [
    // Not "low": the shell's "Low-bandwidth mode" toggle is copy that stays.
    [/\bpriority\b|\b(high|medium)\b/i, 'a priority'],
    [/\bbulk\b|\breassign\b|select all/i, 'bulk actions'],
    [/\bundo\b|\breopen\b/i, 'Undo'],
    [/google|microsoft|outlook|\bteams\b|connect (your )?(work )?calendar/i, 'an external calendar'],
    [/holiday|independence day/i, 'a public holiday'],
    [/\bAI\b/, 'the AI brief'],
    [/meeting prep|prep brief|\bbrief\b/i, 'the AI brief'],
    [/booking|book a demo/i, 'a booking page'],
    [/check[- ]?in|field visit|\bvisit\b|\bdemo\b|\binternal\b/i, 'check-in or a type that is not one'],
    [/attendees?|organi[sz]er|\brsvp\b|\bjoin\b|directions/i, 'attendees or a location'],
    // "Remind me tomorrow" may name a snooze; reminding the CUSTOMER by a channel is out (D-P29).
    [/remind (the )?(customer|contact)|reminder channel|hours? before|\bby (whatsapp|sms|email)\b/i, 'a reminder channel'],
    [/\bclash(es)?\b|double-booked|next free slot/i, 'clash detection against calendars Kasuwa cannot read'],
    [/done today|best week|\bstreak\b|you finished/i, 'a productivity count'],
    [/queued|sync queue/i, 'an offline queue'],
  ];
  const check = async (where: string) => {
    const copy = await copyText(page.locator('body'));
    for (const [pattern, what] of banned) {
      expect(copy, `${what} is drawn on ${where}`).not.toMatch(pattern);
    }
    expect(copy, `a count is drawn on ${where} (D-P13)`).not.toMatch(/\(\s*\d+\s*\)|\b\d+\s+(tasks?|events?|meetings?|overdue|due|done|selected)\b/i);
    await expect(page.locator('[data-activity-type="visit"], [data-activity-type="demo"], [data-activity-type="internal"]')).toHaveCount(0);
    await expect(screen(page).locator('[data-activity] input[type="checkbox"], [data-calendar-event] input[type="checkbox"]'), `row selection on ${where}`).toHaveCount(0);
    await expect(page.locator('[aria-hidden="true"]', { hasText: /^\s*(auto_awesome|flag|schedule_send|event_busy)\s*$/ }), `a hidden feature's icon on ${where}`).toHaveCount(0);
  };
  await check('My tasks');
  await openCalendar(page);
  await check('the calendar');
  await openComposer(page, 'meeting');
  await check('the composer');
});

// ===========================================================================
// Mobile
// ===========================================================================

test('at 360px My tasks and the calendar fit without sideways page scroll and pass axe @p07 @p07-mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openActivities(page);
  await bucketsSettled(page);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow(), 'My tasks scrolls sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoSeriousAxe(page, 'P07/01 at 360px');
  await openCalendar(page);
  expect(await overflow(), 'the calendar scrolls sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoIdsAnywhere(page, 'the 360px calendar');
  await expectNoSeriousAxe(page, 'P07/05 at 360px');
});

// ===========================================================================
// i18n
// ===========================================================================

test('locale=en-XA renders every string as pseudo text, record data and times excepted @p07 @p07-pseudo', async ({ page }) => {
  await openActivities(page, { query: '?locale=en-XA' });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  await bucketsSettled(page);
  const report = (root: Locator) =>
    root.evaluate((element, servedJson) => {
      const pseudo = (text: string) => /[·[\]äëïöüÄËÏÖÜ]/.test(text);
      const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length >= 2;
      const recordish = (text: string) => servedJson.includes(text) || servedJson.includes(JSON.stringify(text).slice(1, -1));
      const skipped = (node: Element | null) =>
        node === null || node.closest('[aria-hidden="true"], [data-testid^="language-"], script, style, noscript, time') !== null;
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

  const tasks = await report(page.locator('[data-shell="crm"]'));
  expect(tasks.english, 'strings on My tasks that did not come through i18n').toEqual([]);
  expect(tasks.forged, 'UI copy marked data-record-text that is not served record data').toEqual([]);
  expect(tasks.pseudoCount, 'almost no pseudo text: the check saw nothing').toBeGreaterThanOrEqual(10);
  for (const name of BUCKETS as Bucket[]) {
    expect(await bucketChrome(page, name), `the ${name} bucket label is not translated`).toMatch(PSEUDO);
  }
  await openCalendar(page);
  const week = await report(page.locator('[data-shell="crm"]'));
  expect(week.english, 'strings on the calendar that did not come through i18n').toEqual([]);
  expect(week.forged).toEqual([]);
  const composer = await openComposer(page, 'meeting');
  const form = await report(composer);
  expect(form.english, 'strings in the composer that did not come through i18n').toEqual([]);
});

// ===========================================================================
// Budget
// ===========================================================================

test.describe('/activities on the wire', () => {
  /**
   * WHY 255,000 BYTES, BEFORE THE SCREEN EXISTS
   *
   * Provisional, the same ceiling T-0058 gave /leads on the same reasoning:
   * the same shell, fonts and records clients as its measured neighbours
   * (/leads measured about 223,700 B and is pinned at 234,900), plus a
   * calendar grid, a composer with a picker and a reschedule form. The
   * builder measures it on the first green run; the lead re-pins it within 5%
   * of that measurement. The calendar may load when first opened
   * (`next/dynamic`), so My tasks' first paint does not carry it.
   */
  test('/activities stays inside its transferred-byte budget on the production build @p07 @p07-budget', async ({ page }) => {
    // No fixed clock here: Playwright's fake clock replaces window.performance, so the first
    // contentful paint this measures would never be reported (D-L118).
    active = await installActivitiesMock(page);
    const metrics = await measurePageLoad(page, `${activitiesUrl()}/activities`, 'default');

    const record = resolve(__dirname, '.artifacts', 'p07-budget.json');
    mkdirSync(resolve(__dirname, '.artifacts'), { recursive: true });
    writeFileSync(
      record,
      `${JSON.stringify({ path: '/activities', transferredBytes: metrics.transferredBytes, budget: ACTIVITIES_BUDGET_BYTES }, null, 2)}\n`,
      'utf8',
    );

    // Bytes from `next dev` are not a budget (D-L28): prove this is the build.
    const html = await page.content();
    const built = readFileSync(resolve(__dirname, '..', '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
    expect(servedBuildId(html), 'webActivitiesUrl is not serving the production build').toBe(built);
    // A 404 page is small: a budget met by the not-found page measures nothing.
    await expect(screen(page)).toBeVisible();

    expect(ACTIVITIES_BUDGET_BYTES).toBeLessThan(300_000);
    assertWithinByteBudget('P07/01 the activities screen', metrics.transferredBytes, ACTIVITIES_BUDGET_BYTES);
  });

  test('/activities paints within 5 s at 256 kbps and 300 ms @p07 @p07-budget', async ({ page }) => {
    active = await installActivitiesMock(page);
    const metrics = await measurePageLoad(page, `${activitiesUrl()}/activities`, 'low-bandwidth');
    await expect(screen(page)).toBeVisible();
    expect(metrics.fcpMs, 'first contentful paint on the PRD 2.13 link').toBeLessThan(5_000);
  });
});
