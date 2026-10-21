import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, posix, relative, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  FLAGS,
  featureFlagClient,
  initialiseFeatureFlags,
  toEvaluationContext,
} from '@kasuwa/feature-flags';
import { OUTCOMES_FILE, type E2eOutcome } from '../support/e2e-outcomes-reporter';

/**
 * ACCEPTANCE — T-0101, the P26 bell and notification centre (Agent 11,
 * Frontend & Design System), against T-0099's contract (tag `notifications`)
 * as T-0100 serves it, on mocks. Decisions: D-P21, D-P29, D-L87, D-L134,
 * D-L146, D-L154, D-L157, D-L164, D-L168, D-L171, D-L174, D-L175, D-L176.
 * Written by the lead's QA agent before the screens exist (D-L23).
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. `crm_notifications`: registered, DEFAULT OFF, NOT production-ready, read
 *      on the server through `lib/feature-flags.ts`. `/notifications`
 *      (`apps/web/app/notifications/page.tsx`) calls `notFound()` on it, so with
 *      every flag at its default it is a real 404. No client module names it.
 *      `crmLiveNav()` lists `notifications` exactly when it is on, and the CRM
 *      shell draws the bell only where `live.includes('notifications')`.
 *   2. The harness: a NEW web process carrying exactly the records process's
 *      flags plus `crm_notifications`, published as `webNotificationsUrl`. The
 *      records process does not carry it.
 *   3. A client in `apps/web/lib/` calls the four operations same-origin,
 *      Zod-parsed, never from the HTTP cache, with no scope argument; and a pure
 *      `notificationHref` that decides every link.
 *   4. The bell and the centre against the contract mock, by e2e tag (section 7;
 *      hooks and rules in the header of `tests/e2e/p26-notifications.spec.ts`).
 *   5. i18n under `notifications.*` in all eight full catalogues; no colour
 *      literal, no device storage, no HTML built from strings, no host-locale
 *      formatting.
 *
 * RULINGS (the suite is written to these; the lead accepts or amends them)
 *
 *   I1. Flag. `crm_notifications`, a PRESENTATION switch (T-0100 decision 8,
 *       accepted in D-L174): it gates the screens, never the API. T-0100
 *       declares it on agent3/T-0100-notifications-api, but it is NOT on main
 *       when this is written. The screens require it. If T-0101 is built before
 *       T-0100 merges, the builder declares it IDENTICALLY (T-0100's entry
 *       verbatim: default off, not production-ready, the same owner and
 *       description) and rebases after T-0100 merges, as T-0096 did `crm_import`.
 *   I2. Harness. The bell polls on EVERY screen of the shell it is in, and the
 *       twelve pinned records-ui mocks record any undeclared `/api/v1` call as a
 *       violation. So `crm_notifications` does NOT ride on the records process
 *       (that would turn twelve suites red for a reason none of them is about);
 *       it gets its own `next start` process on the same production build,
 *       NODE_ENV=test, with EXACTLY the records process's flags plus
 *       `crm_notifications`, so its pages are the records pages with the bell and
 *       the bell's weight is measurable as a difference (I21). It runs in the
 *       records process's auth mode. AMENDED (lead, D-L188): only the
 *       records processes NOT in `jwt` mode are judged. T-0125's
 *       `@bff-session` process is jwt with `crm_records` alone; it exists to
 *       prove the real session, not to twin the records flags, so it is
 *       excluded by its KASUWA_AUTH_MODE.
 *   I3. Client. The four operations from the BROWSER, same-origin, Zod-parsed
 *       (`.uuid()` ids, `.datetime()` times, D-L176 N9), `no-store`, no scope
 *       argument. Nothing about notifications is kept on the device (D-P21).
 *   I4. The bell, in the CRM shell AND the admin shell, where the flag is live:
 *       a button with `aria-haspopup="dialog"` and `aria-expanded`, whose
 *       accessible name carries the count; a badge with the count (1..99), "99+"
 *       when `capped`, nothing at 0. The capped name differs from the name at
 *       exactly 99. The badge is not a live region.
 *   I5. Polling (contract: `x-kasuwa-poll-interval-seconds`, "poll this route,
 *       and only this route"). The count is read on mount, then every 30 to 60 s
 *       while the page is visible (C1), by ONE poller per page however many bells
 *       are drawn. Hidden: no reads. Shown again (visibilitychange plus focus): a
 *       read at once, at most two. Ten focus events in a second: at most two
 *       reads. The list is never read on a timer, by the dropdown or the centre.
 *   I6. Back-off. A 429 on the count: the next read waits the whole
 *       `Retry-After`, even past the cadence. A 500 or a network failure: the
 *       waits grow (the third at least 1.5 times the first, none shrinking), are
 *       never shorter than the cadence and never longer than five minutes (it
 *       never gives up), and a success returns to the cadence. A failure never
 *       clears or changes the badge.
 *   I7. Latest answer wins. A count read that was in flight across a local
 *       change (a mark-read) never overwrites the newer state.
 *   I8. The dropdown (A, A1, A3). Opening it reads the first page once (no
 *       cursor; `limit` and `filter` are the builder's), every opening reads
 *       afresh, and nothing while open. A labelled `dialog`, focus moved inside
 *       and trapped, Escape closes it and returns focus to the bell. Grouped by
 *       the reader's local day. Links `/notifications`. Nothing unread: "all
 *       caught up" (A3) and no usable mark-all.
 *   I9. The centre (B, B2), `/notifications` in the CRM shell. Filters "all" and
 *       "unread" (`filter=unread`), and one kind or all kinds (`kind=<kind>`, one
 *       kind, never a list), each read from the top (no cursor). Paging by
 *       `nextCursor` exactly as served, appended in served order; a short or
 *       EMPTY page with a non-null cursor is not the end (never B2, and the way
 *       on stays or the screen continues by itself); `nextCursor: null` is the
 *       end, and the control goes. B2 when the first page is empty and final. An
 *       item of a kind the client does not know is not drawn and fails nothing.
 *   I10. Sentences and links. One translated sentence per kind and object type
 *       (the five differ). Names in `[data-notification-actor]` and
 *       `[data-notification-object]`, `[data-record-text]`, exactly as served,
 *       as text. A null name: no name element and a generic sentence, never
 *       "null", a stand-in or a placeholder. No id, no raw kind or code. A link
 *       ONLY from `notificationHref(item, live)`, where `live` is the object
 *       types whose record route is on in this process: `/contacts/<id>`,
 *       `/accounts/<id>`, `/deals/<id>` exactly, and only for a well-formed uuid;
 *       an activity may link `/activities` and an import `/contacts/import`, or
 *       nothing (no record route takes their id, C9); anything else is null.
 *       Opening an unread item's link marks it read (`{ read: true }`).
 *   I11. Mark one (the dot). `updateNotification` with `{ read: !current }`; the
 *       item shows the answer; the badge follows at once (a re-read, or locally
 *       when not capped), not at the next poll. A 404 removes the item, says
 *       nothing about permission, and is never sent again.
 *   I12. Mark all. ALWAYS with `throughId` (never `{}`), naming the newest item
 *       the view drew (of the filtered kind, with `kind`, in the centre), so a
 *       notification that arrives after the reader looked stays unread
 *       (D-L154). The badge takes the answer's count. Drawn items it covered show
 *       read. A kind filter's mark-all is A1's "mark all <kind> read".
 *   I13. Throttle (D-L134). A 429 on the list or a write is a translated wait
 *       (`notifications-throttled`), never B2 and never a connection error;
 *       nothing of that operation is sent before `Retry-After`; drawn items stay;
 *       a refused write changes nothing drawn.
 *   I14. Lost answers (D-L171 N2, D-L176 B1). A network failure on a mark-read
 *       or a read-all, whether or not it applied, is found out within ten seconds:
 *       by a re-read or by resending THE SAME idempotent request. The item and the
 *       badge end at the server's truth. A lost mark-read is never "undone" by a
 *       mark-unread, and a read-all resend never widens its bound.
 *   I15. Abort on unmount (D-L171 B1, D-L176 N3). Closing the dropdown or leaving
 *       the centre aborts the list read in flight; nothing surfaces after.
 *   I16. i18n under `notifications.*`, every id in all EIGHT full catalogues
 *       (en, ar, fr, ha, ig, pcm, sw, yo; `en-NG` is an overlay); at least one id
 *       per kind naming the kind; `records.error.<code>` for every code the four
 *       operations answer.
 *   I17. No colour literal; no device storage; no HTML from strings; no
 *       host-locale formatting (`toLocale*String()` with no locale, the
 *       97a4ddd lesson); every time a `<time datetime>` of `createdAt`.
 *   I18. Day groups are the reader's LOCAL dates (`data-day`, Intl with the
 *       browser's zone): 23:30 UTC on the 17th is the 18th in Lagos and the 17th
 *       in UTC.
 *   I19. Announcements (D-L171 N11). A rise in the count is announced politely,
 *       once; the first count of a page, an unchanged count and a fall are not;
 *       never assertively. The polite region exists before its first message.
 *   I20. Layout. 360 px: no sideways scroll, 44 px targets (the bell, the dots,
 *       mark-all, the next page), axe-clean; a 1024 px tablet shows the filters
 *       as chips on the page; axe-clean dropdown, centre and B2.
 *   I21. Budget. NOTIFICATIONS_BUDGET_BYTES is a PROVISIONAL 250,000-byte
 *       placeholder under a 255,000 ceiling; the lead re-pins it within 5% of the
 *       builder's first green measurement (D-L118), and until then the budget
 *       check below fails by design. The bell may add at most 8,000 bytes to a
 *       CRM screen's first load (`/search`, with and without the flag); the
 *       dropdown and the centre load on demand. FCP under 5 s at 256 kbps.
 *   I22. Privacy. No name in the console, a URL, history or the title; no id
 *       printed.
 *
 * WHERE THE TASK FILE, THE CONTRACT OR THE DESIGN DISAGREE (ruled for what is
 * built)
 *
 *   C1. Cadence: the task file says 60 s, the contract's
 *       `x-kasuwa-poll-interval-seconds` says 30. Any cadence from 30 to 60 s.
 *   C2. Per-type counts on the tabs, "{{ unreadTotal }} unread": per-kind counts
 *       are not served and the count is capped at 99 (and may undercount past
 *       500). No per-kind count, no exact total.
 *   C3. A1 "clear the noisiest type in one tap": unknowable without per-kind
 *       counts. The one-tap clear is the kind filter's mark-all (`kind` plus
 *       `throughId`); assignments are two kinds, so two calls (the contract).
 *   C4. Titles, bodies, "Critical", inline Approve/Reject/Undo, the security
 *       banner (A2), toasts (C), preferences (D, D1), push (E–E2): not built
 *       (D-P29 stores no text; the task file's non-goals). No "Preferences" link,
 *       which would be a 404.
 *   C5. The task file puts the bell in "the CRM shell"; the lead's brief adds the
 *       admin shell. Both are pinned (I4).
 *   C6. T-0100's flag description says "in the CRM shell". The description is
 *       T-0100's text and is not pinned; the admin shell's bell is behind the same
 *       flag.
 *   C7. The design's "4m ago": allowed, as the text of a `<time datetime>`.
 *   C8. The task file's "mark read or unread by the dot": pinned both ways; the
 *       contract serves `{ read: false }`.
 *   C9. "Links ... only to record routes": there is no record route for an
 *       activity id or an import id. An activity may link `/activities` and an
 *       import `/contacts/import`, or nothing.
 *   C10. FOR THE LEAD: I2's fourth `next start` process costs the CI runner about
 *       a gigabyte. The alternative is re-pinning twelve records-ui mocks to
 *       answer the count; this suite rules for the process.
 *   C11. FOR THE LEAD: D-L174's follow-up (a cursor row lost to programme removal
 *       or the actor cascade silently ends paging) is invisible to a client; not
 *       pinned.
 *   C12. The task file's "about 450 lines" will not hold with the harness
 *       process, the bell in two shells and the model; not pinned.
 *
 * BUILDER'S CHOICES: the layout; the dropdown's `limit` and whether it shows
 * read items; whether the centre continues past an empty page by itself;
 * whether a 429 retries by itself; how the badge follows a mark-read (re-read or
 * local); the copy; the slice's files.
 *
 * NOT HELD HERE, AND WHY
 *   - The live journey against T-0100's real API: a follow-up once both merge,
 *     as for T-0096 and T-0097.
 *   - A record route switched OFF in a browser: every e2e process with the bell
 *     has them all on. The off half is held by the `notificationHref` table
 *     below, and the static gate on the route.
 *   - Toasts, the banner, approvals, preferences, push (C4).
 *
 * THE BROWSER HALF. `tests/e2e/p26-notifications.spec.ts` (journeys) and
 * `tests/e2e/support/notifications-mock.ts` (the contract mock, which checks
 * every request and every answer against the YAML) were written with this suite
 * and are PINNED by hash below, because `tests/e2e` is not path-protected
 * (D-L64). NOTIFICATIONS_BUDGET_BYTES is the one line that may change without a
 * re-pin.
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p26-notifications --reporter=list,<ours>
 *
 * spawned with `shell: false` and the arguments as an array (D-L62). Every test
 * is read from the outcomes file our reporter writes, so a skipped, `fixme`d or
 * unmatched test never counts.
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const FLAG = 'crm_notifications';

const ROUTE = 'apps/web/app/notifications/page.tsx';
const ROUTE_DIRECTORY = 'apps/web/app/notifications/';
const SHELL_DIRECTORY = 'apps/web/components/crm/';
const CRM_SHELL = 'apps/web/components/crm/crm-shell.tsx';
const ADMIN_SHELL = 'apps/web/components/admin/admin-shell.tsx';

const E2E_TAG = '@p26-notifications';

/** `next build` (SWC wasm on the dev host, D-L62), a container, the servers and the journeys (several drive ten minutes of page clock). */
const E2E_RUN_TIMEOUT_MS = 2_700_000;

const SPEC = 'tests/e2e/p26-notifications.spec.ts';
const MOCK = 'tests/e2e/support/notifications-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/p26-notifications-budget.json';
const CONTRACT = 'docs/api/records.openapi.yaml';

/**
 * The pinned browser half (CRLF folded to LF; the budget literal normalised).
 * A change to either file is a change to the acceptance contract: the lead
 * re-pins it, the builder does not.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  [SPEC]: 'ecf6df9b922155febca05c6af168511df989666dce220fcf16ab38633eca68cc',
  [MOCK]: '0ad1899ae4c702ba4d53d0728052adcabffef3c5a056653109866e7ca2bf9e9d',
};

/** Never above this (I21). */
const NOTIFICATIONS_BUDGET_CEILING = 270_000; // D-L203: T-0145 measured, after removing the weight it could (no visual change)
const BUDGET_HEADROOM = 1.05;
const PRD_CEILING_BYTES = 300 * 1024;

const NOTIFICATIONS_OPERATIONS: readonly (readonly [path: string, method: string, operationId: string])[] = [
  ['/api/v1/notifications', 'get', 'listNotifications'],
  ['/api/v1/notifications/unread-count', 'get', 'getNotificationUnreadCount'],
  ['/api/v1/notifications/read-all', 'post', 'markAllNotificationsRead'],
  ['/api/v1/notifications/{notificationId}', 'patch', 'updateNotification'],
];

/** What the client must name to reach the four operations. */
const CLIENT_PATHS = ['/notifications/unread-count', '/notifications/read-all'];

/** The eight full catalogues (I16). `en-NG` is an overlay of a handful of keys. */
const FULL_CATALOGUES = ['en', 'ar', 'fr', 'ha', 'ig', 'pcm', 'sw', 'yo'];

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the mock's validators
  // fire, so every afterEach "no violations" means something.
  ['@p26-notifications-mock', 'the contract mock refuses what the contract and the screens’ rules refuse, and checks its own answers'],
  // Passes before the work starts too (no route, no bell): a negative
  // invariant, given meaning by @p26-notifications-flag-on.
  ['@p26-notifications-flag-off', '/notifications is a 404 at the defaults; the records process draws no bell and reads nothing'],
  ['@p26-notifications-flag-on', 'the centre renders P26 in the CRM shell with the bell; the admin console draws the bell'],
  ['@p26-notifications-bell', 'the badge says 7, 99, 99+ and nothing at 0; the bell’s name carries it; the badge is not a live region'],
  ['@p26-notifications-polling', 'the count every 30–60 s while visible, one poller, the list never on a timer'],
  ['@p26-notifications-hidden', 'hidden reads nothing; shown reads at once; a focus burst is one or two reads'],
  ['@p26-notifications-backoff', 'failures back off, bounded at five minutes, keep the badge, and return to the cadence'],
  ['@p26-notifications-throttle', '429s honoured for their Retry-After on the count, the list and the dot, translated, nothing drawn lost'],
  ['@p26-notifications-latest', 'a stale count never overwrites a newer state'],
  ['@p26-notifications-dropdown', 'a labelled dialog, one read per opening, focus trapped and returned, day groups, the centre linked, A3'],
  ['@p26-notifications-centre', 'filters unread/all and by kind from the top; unknown kinds ignored; B2'],
  ['@p26-notifications-paging', 'the served cursor, appended in order, an empty page with a cursor not the end, the control gone at the end'],
  ['@p26-notifications-days', 'day groups are the reader’s local dates; every time a <time> of createdAt'],
  ['@p26-notifications-sentences', 'translated sentences per kind and type, names as served, withheld names generic, no id or code'],
  ['@p26-notifications-links', 'links only to live record routes from well-formed uuids; every link resolves; opening marks read'],
  ['@p26-notifications-markup', 'markup in a name drawn as text'],
  ['@p26-notifications-mark-read', 'the dot reads and unreads, the badge follows at once, a 404 removes the item'],
  ['@p26-notifications-read-all', 'mark-all bounded by throughId, an arrival stays unread, the kind filter marks that kind'],
  ['@p26-notifications-lost', 'lost write answers are found out and drawn as the server’s truth'],
  ['@p26-notifications-abort', 'closing the dropdown or leaving the centre aborts the list read'],
  ['@p26-notifications-announce', 'a rise announced politely once; first, unchanged and falling counts not; never assertive'],
  ['@p26-notifications-privacy', 'no name in the console, URLs, history or title; nothing on the device'],
  ['@p26-notifications-axe', 'the dropdown, the centre and B2 axe-clean'],
  ['@p26-notifications-mobile', '360 px without sideways scroll, 44 px targets, axe-clean'],
  ['@p26-notifications-tablet', 'a 1024 px tablet shows the filters as chips, no sideways scroll'],
  ['@p26-notifications-pseudo', 'en-XA renders every string as pseudo text, record data excepted'],
  ['@p26-notifications-budget', 'the centre inside its byte budget and 5 s FCP; the bell inside 8,000 bytes on every CRM screen'],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SourceFile {
  file: string;
  source: string;
}

function trackedFiles(directory: string): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', directory], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function webSources(): SourceFile[] {
  return trackedFiles('apps/web')
    .filter((file) => /\.(tsx?|mjs)$/.test(file) && !/\.test\.tsx?$/.test(file) && existsSync(fromRoot(file)))
    .map((file) => ({ file, source: readFileSync(fromRoot(file), 'utf8') }));
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Shared shells other suites hold. Followed when they are a root, never counted as the slice's own otherwise. */
const OTHER_SHELLS = ['apps/web/components/auth/', 'apps/web/components/admin/', SHELL_DIRECTORY];

/**
 * The files reachable from `roots` by relative import, minus the shells. With
 * `dynamic` false, only imports that load with the module are followed;
 * type-only imports are erased at build and never followed.
 */
function reachableFrom(
  roots: readonly string[],
  dynamic: boolean,
  skip: readonly string[] = OTHER_SHELLS,
  sources: ReadonlyMap<string, string> = new Map(webSources().map((entry) => [entry.file, entry.source])),
): Set<string> {
  const resolveImport = (from: string, specifier: string): string | undefined => {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    return [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) => sources.has(candidate));
  };
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift() ?? '';
    if (seen.has(file) || (!roots.includes(file) && skip.some((shell) => file.startsWith(shell)))) continue;
    seen.add(file);
    const code = withoutComments(sources.get(file) ?? '');
    const specifiers = [
      ...[...code.matchAll(/\b(import|export)(\s+type\b)?[^'"`;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g)].filter((match) => match[2] === undefined).map((match) => match[3] ?? ''),
      ...[...code.matchAll(/\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map((match) => match[1] ?? ''),
      ...(dynamic ? [...code.matchAll(/\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].map((match) => match[1] ?? '') : []),
    ];
    for (const specifier of specifiers) {
      const target = resolveImport(file, specifier);
      if (target !== undefined && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

/** A web file that draws the bell (its test id in code). */
function drawsBell(source: string): boolean {
  return /['"`]notifications-bell['"`]/.test(withoutComments(source));
}

/** A web file that is the centre's screen (data-screen "P26"). */
function isCentre(source: string): boolean {
  return /['"`]P26['"`]/.test(withoutComments(source));
}

/**
 * The slice: the route directory and every file that draws the bell, and
 * everything they import by a relative path, transitively, minus the shared
 * shells (which are followed only when they are themselves a root).
 */
function screenSlice(): SourceFile[] {
  expect(existsSync(fromRoot(ROUTE)), `there is no ${ROUTE}`).toBe(true);
  const sources = new Map(webSources().map((entry) => [entry.file, entry.source]));
  const roots = [...sources.entries()].filter(([file, source]) => file.startsWith(ROUTE_DIRECTORY) || (drawsBell(source) && file !== CRM_SHELL && file !== ADMIN_SHELL)).map(([file]) => file);
  const files = [...reachableFrom(roots, true, OTHER_SHELLS, sources)].sort();
  const slice = files.map((file) => ({ file, source: sources.get(file) ?? '' }));
  expect(slice.filter(({ source }) => isCentre(source)).map(({ file }) => file), 'the /notifications route imports no P26 centre (data-screen="P26")').not.toEqual([]);
  expect(slice.filter(({ source }) => drawsBell(source)).map(({ file }) => file), 'no web file draws the bell (data-testid="notifications-bell")').not.toEqual([]);
  return slice;
}

/** apps/web/lib modules that call the notifications operations. */
function notificationsClients(): SourceFile[] {
  return webSources().filter(({ file, source }) => file.startsWith('apps/web/lib/') && CLIENT_PATHS.some((path) => withoutComments(source).includes(path)));
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8')) as Record<string, string>;
}

const BUDGET_LITERAL = /const NOTIFICATIONS_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8').replace(/\r\n/g, '\n').replace(BUDGET_LITERAL, 'const NOTIFICATIONS_BUDGET_BYTES = <budget>;');
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

type Json = Record<string, unknown>;

interface Contract {
  paths: Record<string, Record<string, { operationId?: string; responses: Record<string, Json> }>>;
  components: { responses: Record<string, Json>; schemas: Record<string, Json> };
}

function contract(): Contract {
  return parse(readFileSync(fromRoot(CONTRACT), 'utf8')) as Contract;
}

/** Error `code`s an operation can answer with, from the contract's examples (inline and referenced). */
function errorCodes(path: string, method: string): string[] {
  const spec = contract();
  const operation = spec.paths[path]?.[method];
  expect(operation, `${method.toUpperCase()} ${path} is gone from the records contract`).toBeDefined();
  const codes = new Set<string>();
  for (const [status, raw] of Object.entries(operation?.responses ?? {})) {
    if (status.startsWith('2')) continue;
    const response = typeof raw.$ref === 'string' ? spec.components.responses[raw.$ref.split('/').at(-1) ?? ''] : raw;
    const body = (response?.content as Json | undefined)?.['application/json'] as { example?: { code?: string }; examples?: Record<string, { value?: { code?: string } }> } | undefined;
    for (const example of [body?.example, ...Object.values(body?.examples ?? {}).map((entry) => entry.value)]) {
      if (typeof example?.code === 'string') codes.add(example.code);
    }
  }
  return [...codes].sort();
}

/**
 * Colour written into a web source rather than read from a token. The same
 * detector as the other records-ui suites (D-L84: the lint rule sees only a
 * string that IS a hex value).
 */
function colourLiterals(source: string): string[] {
  const code = withoutComments(source);
  const patterns = [
    /['"`][^'"`\n]*#[0-9a-fA-F]{3,8}(?![\w-])[^'"`\n]*['"`]/g,
    /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix)\(/g,
    /\b[a-z-]+-\[(?:#|rgb|hsl|oklch|color)/g,
    /\b(?:bg|text|border|ring|fill|stroke|outline|divide|from|to|via|accent|caret|decoration|shadow|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g,
    /\b(?:bg|text|border|ring|fill|stroke|outline|divide)-(?:white|black)\b/g,
    /\b(?:color|background(?:Color)?|borderColor|fill|stroke)\s*:\s*['"`](?!var\(|currentColor|inherit|transparent|none)[a-z#]/gi,
  ];
  return patterns.flatMap((pattern) => code.match(pattern) ?? []);
}

/** A device-storage API (D-P21): web storage, IndexedDB, caches, service workers, the file system, cookies. */
const DEVICE_STORAGE = /\b(localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|navigator\.storage|document\.cookie|showSaveFilePicker|showOpenFilePicker|getDirectory)\b/;

/** Markup built from strings (I10): a name must be drawn as text. */
function htmlInjection(source: string): string[] {
  return withoutComments(source).match(/\bdangerouslySetInnerHTML\b|\.(?:innerHTML|outerHTML)\s*=|\binsertAdjacentHTML\b|\bdocument\.write\b|\bcreateContextualFragment\b/g) ?? [];
}

/** Formatting in the HOST's locale (I17): a `toLocale*String()` call with no locale argument. */
function hostLocaleFormatting(source: string): string[] {
  return withoutComments(source).match(/\.toLocale(?:Date|Time)?String\(\s*\)/g) ?? [];
}

/** ESLint from the workspace root, run as node with no shell. */
function eslint(args: readonly string[], input?: string): { status: number | null; output: string } {
  const require = createRequire(fromRoot('package.json'));
  const bin = resolve(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
  const run = spawnSync(process.execPath, [bin, ...args], { cwd: repoRoot, encoding: 'utf8', shell: false, input, maxBuffer: 64 * 1024 * 1024 });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error?.message ?? ''}` };
}

/** The exported readers in lib/feature-flags.ts whose body evaluates `flag` by name. */
function readersOf(flag: string): string[] {
  const flagModule = withoutComments(readFileSync(fromRoot('apps/web/lib/feature-flags.ts'), 'utf8'));
  const named = new RegExp(`['"]${flag}['"]`);
  return [...flagModule.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)].filter((match) => named.test(match[2] ?? '')).map((match) => match[1] ?? '');
}

/** The body of an exported async function in lib/feature-flags.ts. */
function flagFunctionBody(name: string): string {
  const flagModule = withoutComments(readFileSync(fromRoot('apps/web/lib/feature-flags.ts'), 'utf8'));
  const match = new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(flagModule);
  return match?.[1] ?? '';
}

/** The KASUWA_FEATURE_FLAGS_ON lists of every web process in run-e2e.mjs. */
function processFlagLists(runner: string): string[][] {
  return [...runner.matchAll(/KASUWA_FEATURE_FLAGS_ON:\s*['"`]([^'"`]*)['"`]/g)].map((match) => (match[1] ?? '').split(/[,\s]+/).filter((flag) => flag.length > 0));
}

/**
 * Every web process in run-e2e.mjs that names KASUWA_FEATURE_FLAGS_ON, with
 * the KASUWA_AUTH_MODE set in the SAME `env: { ... }` object (D-L188). The
 * runner is cut at each `env: {`, so a mode is never borrowed from another
 * process; `undefined` where the object sets none.
 */
function webProcesses(runner: string): { mode: string | undefined; flags: string[] }[] {
  return runner
    .split(/\benv:\s*\{/)
    .slice(1)
    .flatMap((block) => {
      const flags = /KASUWA_FEATURE_FLAGS_ON:\s*['"`]([^'"`]*)['"`]/.exec(block);
      if (flags === null) return [];
      const mode = /KASUWA_AUTH_MODE:\s*['"`]([^'"`]*)['"`]/.exec(block);
      return [{ mode: mode?.[1], flags: (flags[1] ?? '').split(/[,\s]+/).filter((flag) => flag.length > 0) }];
    });
}

/** The test tags in a spec's code (titles and annotations), comments and package scopes excluded. */
function tagsIn(file: string): string[] {
  return [...withoutComments(readFileSync(fromRoot(file), 'utf8')).matchAll(/@[a-z0-9][\w-]*/gi)].map((match) => match[0]).filter((tag) => /^@(p\d|leads|harness)/i.test(tag));
}

/** A spec's parent tag: the one every other tag in it starts with (the shortest), if any. */
function parentTag(tags: readonly string[]): string | undefined {
  const shortest = [...new Set(tags)].sort((left, right) => left.length - right.length)[0];
  return shortest !== undefined && tags.every((tag) => tag.startsWith(shortest)) ? shortest : undefined;
}

type HrefFunction = (item: unknown, live: readonly string[]) => unknown;

/** The one apps/web/lib module that exports `notificationHref` (I10). */
function hrefModule(): string {
  const exporting = webSources().filter(({ file, source }) => file.startsWith('apps/web/lib/') && /\bexport\s+(?:function\s+notificationHref\b|const\s+notificationHref\b)/.test(withoutComments(source)));
  expect(exporting.map(({ file }) => file), 'no apps/web/lib module exports notificationHref(item, live) (I10)').toHaveLength(1);
  return exporting[0]?.file ?? '';
}

const UUID_A = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01';

function notification(kind: string, objectType: string, objectId: string): Json {
  return {
    id: '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c06',
    kind,
    objectType,
    objectId,
    actor: { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01', displayName: 'Sample Agent' },
    objectDisplayName: 'Sample Customer',
    createdAt: '2026-10-18T09:50:00Z',
    readAt: null,
  };
}

const KIND_OF: Readonly<Record<string, string>> = { contact: 'record_assigned', account: 'record_assigned', deal: 'record_assigned', activity: 'task_assigned', import: 'import_finished' };
const ALL_LIVE = ['contact', 'account', 'deal', 'activity', 'import'];
const RECORD_ROUTES: Readonly<Record<string, string>> = { contact: '/contacts/', account: '/accounts/', deal: '/deals/' };
const LIST_ROUTES: Readonly<Record<string, string>> = { activity: '/activities', import: '/contacts/import' };
const MALFORMED_IDS = [
  '../../admin/roles',
  'not-a-uuid',
  `${UUID_A}/../../admin`,
  `${UUID_A}?tab=x`,
  `${UUID_A}#x`,
  ` ${UUID_A}`,
  `${UUID_A}\n`,
  'javascript:alert(1)',
  '',
  '%2e%2e%2fadmin',
  '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e0g',
  '3f0c9a526d1e4b8a9f2e1a2b3c4d5e01',
];

// ===========================================================================
// 1. The flag, the route, the bell's gate, the harness and the client
// ===========================================================================

describe('acceptance: T-0101 — crm_notifications exists, is off, is not production-ready, and gates the centre and the bell', () => {
  it('registers crm_notifications, not production-ready, and it evaluates OFF by default (I1)', async () => {
    // `true` as the fallback on purpose: an unregistered flag returns the
    // fallback, so only a flag that is registered AND defaults off answers false.
    expect(Object.keys(FLAGS), `${FLAG} is not declared in FLAGS (T-0100 declares it; build first, declare it identically, I1)`).toContain(FLAG);
    const definition = (FLAGS as Readonly<Record<string, { productionReady?: boolean; defaultValue?: boolean }>>)[FLAG];
    expect(definition?.defaultValue, `${FLAG} does not default off`).toBe(false);
    expect(definition?.productionReady, `${FLAG} is marked production-ready`).toBe(false);
    await initialiseFeatureFlags();
    const value = await featureFlagClient().getBooleanValue(FLAG, true, toEvaluationContext({ tenantId: 'acceptance-probe' }));
    expect(value, `${FLAG} does not evaluate OFF by default`).toBe(false);
  });

  it('has /notifications calling notFound() on crm_notifications, read on the server only (I1)', () => {
    expect(existsSync(fromRoot(ROUTE)), `there is no ${ROUTE}`).toBe(true);
    const source = withoutComments(readFileSync(fromRoot(ROUTE), 'utf8'));
    expect(source, `${ROUTE} does not call notFound()`).toMatch(/\bnotFound\s*\(/);
    expect(source, `${ROUTE} imports nothing from lib/feature-flags`).toMatch(/from ['"][./]*lib\/feature-flags['"]/);
    const readers = readersOf(FLAG).filter((name) => name !== 'crmLiveNav');
    const gated = readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source)) || new RegExp(`['"]${FLAG}['"]`).test(source);
    expect(gated, `${ROUTE} is not gated on ${FLAG} (readers found: ${readers.join(', ') || 'none'})`).toBe(true);
    const clientEvaluators = webSources().filter(({ source: code }) => /^\s*['"]use client['"]/m.test(code) && code.includes(FLAG));
    expect(clientEvaluators.map(({ file }) => file), `a client module names ${FLAG}: flags are read on the server only`).toEqual([]);
  });

  it('lists notifications in crmLiveNav() only through crm_notifications, and the CRM shell draws the bell only where live.includes("notifications") (I1, I4)', () => {
    const live = flagFunctionBody('crmLiveNav');
    expect(live, 'crmLiveNav() is gone from lib/feature-flags.ts').not.toBe('');
    expect(live, 'crmLiveNav() never lists notifications').toMatch(/['"]notifications['"]/);
    const readers = readersOf(FLAG).filter((name) => name !== 'crmLiveNav');
    expect(readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(live)) || new RegExp(`['"]${FLAG}['"]`).test(live), 'crmLiveNav() does not read crm_notifications: the bell would show with the flag off').toBe(true);
    const shell = withoutComments(readFileSync(fromRoot(CRM_SHELL), 'utf8'));
    expect(shell, 'the CRM shell does not ask live.includes("notifications") before drawing the bell').toMatch(/\.includes\(\s*['"]notifications['"]\s*\)/);
    for (const root of [CRM_SHELL, ADMIN_SHELL]) {
      const reached = reachableFrom([root], true, []);
      const bells = [...reached].filter((file) => drawsBell(readFileSync(fromRoot(file), 'utf8')));
      expect(bells, `${root} reaches no file that draws the bell (I4: the bell is in the CRM and the admin shells)`).not.toEqual([]);
    }
  });

  it('serves the bell from its OWN web process: exactly the records flags plus crm_notifications, published as webNotificationsUrl; the records process stays without it (I2)', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    const processes = webProcesses(runner);
    // D-L188: a jwt-mode process (T-0125's `@bff-session` process, ADR-0019
    // amendment 1) exists to prove the real session, not to twin the records
    // flags, so it is excluded BY ITS AUTH MODE. Only `jwt` is excluded: a
    // process whose mode cannot be read is still judged.
    const judged = processes.filter(({ mode }) => mode !== 'jwt');
    const records = judged.filter(({ flags }) => flags.includes('crm_records') && !flags.includes(FLAG));
    expect(records.map(({ flags }) => flags), 'run-e2e.mjs has no stub-mode records process without crm_notifications, or more than one (twelve pinned mocks would see the bell’s poll)').toHaveLength(1);
    const withFlag = processes.filter(({ flags }) => flags.includes(FLAG));
    expect(withFlag.map(({ flags }) => flags), `no web process in run-e2e.mjs carries ${FLAG}, or more than one does`).toHaveLength(1);
    expect([...(withFlag[0]?.flags ?? [])].sort(), 'the notifications process is not the records process plus crm_notifications: the bell’s weight would not be a difference').toEqual([...(records[0]?.flags ?? []), FLAG].sort());
    expect(withFlag[0]?.mode, 'the notifications process does not run in the records process’s auth mode (D-L188: it twins it)').toBe(records[0]?.mode);
    expect(runner, 'run-e2e.mjs does not publish webNotificationsUrl in the stack file').toContain('webNotificationsUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*''/);
  });

  it('calls the four operations same-origin, Zod-parsed, never from the HTTP cache, with no scope argument (I3)', () => {
    const spec = contract();
    for (const [path, method, operationId] of NOTIFICATIONS_OPERATIONS) {
      expect(spec.paths[path]?.[method]?.operationId, `${method.toUpperCase()} ${path} is no longer ${operationId}`).toBe(operationId);
    }
    const clients = notificationsClients();
    expect(clients.map(({ file }) => file), 'no apps/web/lib module calls the notifications operations').not.toEqual([]);
    const all = clients.map(({ source }) => withoutComments(source)).join('\n');
    for (const path of CLIENT_PATHS) expect(all, `no apps/web/lib module names ${path}`).toContain(path);
    for (const { file, source } of clients) {
      const code = withoutComments(source);
      expect(code, `${file} names an absolute API origin`).not.toMatch(/https?:\/\/[^'"`]*\/api\/v1/);
      expect(code, `${file} does not parse with Zod`).toMatch(/from ['"]zod['"]/);
      expect(code, `${file} builds a scope argument`).not.toMatch(/programmeIds|ownerUserIds|(set|append)\(\s*['"`](programme|owner|scope)|['"`]x-[\w-]*(programme|tenant|scope)|[?&]programmeId=/i);
      // Names of people at a URL that is the same for every user: never the HTTP cache (records-cache.test.ts).
      expect(/\brequestRecords\b/.test(code) || /cache:\s*['"]no-store['"]/.test(code), `${file} neither goes through requestRecords nor sends cache: 'no-store'`).toBe(true);
    }
    for (const { file, source } of webSources()) {
      expect(withoutComments(source), `${file} imports test support`).not.toMatch(/from ['"][^'"]*(tests\/e2e|notifications-mock|@kasuwa\/testing)[^'"]*['"]/);
    }
  });

  it('decides every link with notificationHref(item, live): exact record routes from well-formed uuids only where live, nothing else (I10)', async () => {
    const file = hrefModule();
    const loaded = (await import(fromRoot(file))) as { notificationHref?: HrefFunction };
    const href = loaded.notificationHref;
    expect(typeof href, `${file} does not export a notificationHref function`).toBe('function');
    if (href === undefined) return;
    const failures: string[] = [];
    const want = (what: string, actual: unknown, allowed: readonly (string | null)[]) => {
      if (!allowed.includes(actual as string | null)) failures.push(`${what}: got ${JSON.stringify(actual)}, want ${allowed.map((value) => JSON.stringify(value)).join(' or ')}`);
    };
    for (const objectType of ALL_LIVE) {
      const kind = KIND_OF[objectType] ?? '';
      const live = (types: readonly string[]) => href(notification(kind, objectType, UUID_A), types);
      const record = RECORD_ROUTES[objectType];
      if (record !== undefined) {
        want(`${objectType}, its route live`, live(ALL_LIVE), [`${record}${UUID_A}`]);
        want(`${objectType}, only its own route live`, live([objectType]), [`${record}${UUID_A}`]);
      } else {
        want(`${objectType}, its screen live`, live(ALL_LIVE), [null, LIST_ROUTES[objectType] ?? null]);
      }
      want(`${objectType}, nothing live`, live([]), [null]);
      want(`${objectType}, every route but its own live`, live(ALL_LIVE.filter((type) => type !== objectType)), [null]);
      for (const bad of MALFORMED_IDS) want(`${objectType} with objectId ${JSON.stringify(bad)}`, href(notification(kind, objectType, bad), ALL_LIVE), [null]);
    }
    want('an object type no route knows', href(notification('record_assigned', 'ticket', UUID_A), [...ALL_LIVE, 'ticket']), [null]);
    want('a kind the client does not know', href(notification('deal_won', 'deal', UUID_A), ALL_LIVE), [null, `/deals/${UUID_A}`]);
    expect(failures, 'notificationHref links where it must not, or not where it must').toEqual([]);
  });

  it('keeps the centre out of every shell’s load: neither shell imports the P26 screen, statically or lazily', () => {
    // A static check. The real one is I21's 8,000-byte delta, measured.
    const slice = screenSlice().map(({ file }) => file);
    const centre = slice.filter((file) => isCentre(readFileSync(fromRoot(file), 'utf8')));
    for (const root of [CRM_SHELL, ADMIN_SHELL]) {
      const loaded = reachableFrom([root], true, []);
      expect(centre.filter((file) => loaded.has(file)), `${root} imports the notification centre`).toEqual([]);
    }
  });
});

// ===========================================================================
// 2. i18n — the lint rule, eight catalogues, the error codes, D-P1
// ===========================================================================

describe('acceptance: T-0101 — every string through i18n, in all eight catalogues, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the /notifications route file', () => {
    // Passes before the work starts: a guard that the rule stays live on the route's path.
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(/files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/);
    // A rule only ever seen passing proves nothing: plant a literal at the route's own path.
    const planted = eslint(['--stdin', '--stdin-filename', ROUTE, '--format', 'json'], 'export default function Planted() {\n  return <p>Mark all read</p>;\n}\n');
    expect(planted.output, `a literal JSX string at ${ROUTE} is not rejected:\n${planted.output.slice(-2000)}`).toContain('i18next/no-literal-string');
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const slice = screenSlice();
    const run = eslint(['--max-warnings', '0', ...slice.map(({ file }) => file)]);
    expect(run.status, `eslint fails on the notifications slice:\n${run.output.slice(-4000)}`).toBe(0);
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('has exactly eight full catalogues, the ones this suite names', () => {
    // Passes before the work starts: it guards I16's list against a catalogue added or demoted.
    const en = Object.keys(catalogue('en')).length;
    const full = readdirSync(fromRoot('packages/i18n/src/locales'))
      .filter((name) => /^[a-zA-Z-]+\.json$/.test(name))
      .map((name) => name.replace(/\.json$/, ''))
      .filter((locale) => Object.keys(catalogue(locale)).length === en)
      .sort();
    expect(full).toEqual([...FULL_CATALOGUES].sort());
  });

  it('puts every notifications.* message, every id the slice names and one id per kind in all eight catalogues (I16)', () => {
    const en = catalogue('en');
    const named = new Set<string>();
    for (const { source } of screenSlice()) {
      for (const match of withoutComments(source).matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)) {
        if (match[1] !== undefined && en[match[1]] !== undefined) named.add(match[1]);
      }
    }
    const own = Object.keys(en).filter((id) => id.startsWith('notifications.'));
    // Vacuity guard: the CRM shell alone names about a dozen ids; the screens must add their own namespace.
    expect(own.length, 'en.json has almost no notifications.* message').toBeGreaterThan(15);
    expect([...named].filter((id) => id.startsWith('notifications.')).length, 'the slice names almost no notifications.* message id').toBeGreaterThan(15);
    const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const kinds = ['record_assigned', 'task_assigned', 'import_finished'];
    for (const kind of kinds) {
      expect(own.filter((id) => id.includes(kind) || id.includes(camel(kind))), `en.json has no notifications.* sentence for ${kind} (an id naming it)`).not.toEqual([]);
    }
    const missing: string[] = [];
    for (const locale of FULL_CATALOGUES) {
      const messages = catalogue(locale);
      for (const id of new Set([...own, ...named])) {
        if (typeof messages[id] !== 'string' || messages[id].trim() === '') missing.push(`${locale}: ${id}`);
      }
    }
    expect(missing, 'message ids the notification screens use that a catalogue lacks').toEqual([]);
    for (const id of own) expect(en[id] ?? '', `${id} is a title or body the server would have to send (D-P29)`).not.toMatch(/\bCritical\b|Approve|Reject/);
  });

  it('localises every error the four operations can answer with', () => {
    // Passes before the work starts (the codes are shared ones): a guard that none is dropped.
    const en = catalogue('en');
    const codes = new Set(NOTIFICATIONS_OPERATIONS.flatMap(([path, method]) => errorCodes(path, method)));
    expect([...codes], 'the notifications operations no longer declare their codes').toEqual(expect.arrayContaining(['validation_failed', 'not_authenticated', 'not_found', 'too_many_requests']));
    const missing = [...codes].filter((code) => en[`records.error.${code}`] === undefined);
    expect(missing, 'en.json lacks records.error.<code> for these errors').toEqual([]);
    expect(en['records.error.not_found'] ?? '', 'records.error.not_found talks about permission').not.toMatch(/permission|not allowed|forbidden/i);
  });

  it('drops no design-menu language from the menu (D-P1)', async () => {
    // Passes before the work starts: it guards against the work, not for it.
    const i18n: { DESIGN_MENU_LOCALES: readonly string[]; MENU_LOCALES: readonly string[] } = await import(fromRoot('packages/i18n/src/index.ts'));
    expect(i18n.DESIGN_MENU_LOCALES.length).toBeGreaterThan(1);
    const dropped = i18n.DESIGN_MENU_LOCALES.filter((locale) => !i18n.MENU_LOCALES.includes(locale));
    expect(dropped, 'these languages fell off the menu — translate the new keys in every catalogue').toEqual([]);
  });
});

// ===========================================================================
// 3. Colour, the device, markup, the host's locale, <time>
// ===========================================================================

describe('acceptance: T-0101 — no colour literal, no device storage, no HTML from strings, no host-locale formatting', () => {
  it('the detectors catch what they are for', () => {
    // Planted first: a detector only ever seen finding nothing proves nothing.
    // Passes before the work starts, by design.
    for (const planted of ['className="text-[#c00] p-2"', "style={{ color: 'red' }}", 'className="bg-sky-100"', 'className="border-white"']) {
      expect(colourLiterals(planted), `the colour detector missed ${planted}`).not.toEqual([]);
    }
    expect(colourLiterals('className="bg-surface text-text-2 border-border-strong bg-primary-soft"')).toEqual([]);
    for (const planted of ["localStorage.setItem('unread', String(count))", 'indexedDB.open("inbox")', 'await caches.open("x")', 'document.cookie = "seen=1"']) {
      expect(DEVICE_STORAGE.test(planted), `the device-storage detector missed ${planted}`).toBe(true);
    }
    for (const planted of ['<span dangerouslySetInnerHTML={{ __html: name }} />', 'row.innerHTML = item.actor.displayName;', "list.insertAdjacentHTML('beforeend', name)"]) {
      expect(htmlInjection(planted), `the markup detector missed ${planted}`).not.toEqual([]);
    }
    expect(htmlInjection('<span>{item.objectDisplayName}</span>')).toEqual([]);
    for (const planted of ['new Date(item.createdAt).toLocaleString()', 'count.toLocaleString( )', 'd.toLocaleDateString()']) {
      expect(hostLocaleFormatting(planted), `the host-locale detector missed ${planted}`).not.toEqual([]);
    }
    expect(hostLocaleFormatting("d.toLocaleDateString(locale, { timeZone })")).toEqual([]);
    expect(drawsBell('<button data-testid="notifications-bell">')).toBe(true);
    expect(drawsBell('// data-testid="notifications-bell"')).toBe(false);
    // The import walk, on planted modules: a static import is seen, a dynamic one only when asked.
    const shell = 'apps/web/components/crm/crm-shell.tsx';
    const centre = 'apps/web/components/notifications/centre.tsx';
    const planted = (code: string) => new Map([[shell, code], [centre, "export const id = 'P26';"]]);
    expect(reachableFrom([shell], false, [], planted("import { Centre } from '../notifications/centre';")).has(centre)).toBe(true);
    expect(reachableFrom([shell], false, [], planted("import type { CentreProps } from '../notifications/centre';")).has(centre)).toBe(false);
    expect(reachableFrom([shell], true, [], planted("const Lazy = dynamic(() => import('../notifications/centre'));")).has(centre)).toBe(true);
    // The run-e2e flag reader, on a planted runner.
    expect(processFlagLists("KASUWA_FEATURE_FLAGS_ON: '',\nKASUWA_FEATURE_FLAGS_ON: 'crm_records,crm_notifications',")).toEqual([[], ['crm_records', 'crm_notifications']]);
    // The per-process reader (D-L188): each mode stays with its own env object, never the next one's.
    expect(
      webProcesses("env: { KASUWA_FEATURE_FLAGS_ON: '' },\nenv: { KASUWA_AUTH_MODE: 'jwt', KASUWA_FEATURE_FLAGS_ON: 'crm_records' },\nenv: { KASUWA_AUTH_MODE: 'stub', KASUWA_FEATURE_FLAGS_ON: 'crm_records,crm_notifications' }"),
    ).toEqual([
      { mode: undefined, flags: [] },
      { mode: 'jwt', flags: ['crm_records'] },
      { mode: 'stub', flags: ['crm_records', 'crm_notifications'] },
    ]);
  });

  it('writes no colour literal anywhere in the slice', () => {
    const found = screenSlice().flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the notifications slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('touches no device-storage API, builds no HTML from strings and formats nothing in the host’s locale (I3, I10, I17, D-P21)', () => {
    const files = [...screenSlice(), ...notificationsClients()];
    expect(files.filter(({ source }) => DEVICE_STORAGE.test(withoutComments(source))).map(({ file }) => file), 'the notifications slice uses a device-storage API').toEqual([]);
    expect(files.flatMap(({ file, source }) => htmlInjection(source).map((hit) => `${file}: ${hit}`)), 'the notifications slice builds HTML from strings: names are record data, drawn as text').toEqual([]);
    expect(files.flatMap(({ file, source }) => hostLocaleFormatting(source).map((hit) => `${file}: ${hit}`)), 'the notifications slice formats in the host’s locale').toEqual([]);
  });

  it('draws times as <time dateTime> (I17)', () => {
    const slice = screenSlice().filter(({ file }) => file.endsWith('.tsx'));
    expect(slice.some(({ source }) => /<time\b[^>]*\bdateTime=/.test(withoutComments(source))), 'no file in the slice draws a <time dateTime>').toBe(true);
  });
});

// ===========================================================================
// 4. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0101 — the journeys and the mock are the ones this suite was written with', () => {
  it('pins p26-notifications.spec.ts and notifications-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(normalisedHash(file), `${file} changed. It is part of the T-0101 acceptance contract: ask the lead to re-pin it (only NOTIFICATIONS_BUDGET_BYTES may move without that).`).toBe(pinned);
    }
    const mock = readFileSync(fromRoot(MOCK), 'utf8');
    expect(mock, 'the mock no longer reads the records contract').toContain(CONTRACT);
    expect(mock, 'the mock no longer checks its own answers against the contract').toMatch(/answerProblems\(call\.operation, status, (body|validated)\)/);
    expect(mock, 'the mock no longer reads the poll interval from the contract').toContain("'x-kasuwa-poll-interval-seconds'");
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    expect(BUDGET_LITERAL.test(spec), 'NOTIFICATIONS_BUDGET_BYTES is not where it was').toBe(true);
    expect(spec, 'the spec sleeps').not.toMatch(/waitFor[T]imeout|setTimeout\(\s*\w+\s*,\s*[1-9]/);
  });
});

// ===========================================================================
// 5. The tag is these screens' alone (D-L84)
// ===========================================================================

describe('acceptance: T-0101 — @p26-notifications selects these journeys and nothing else', () => {
  it('no other spec carries a tag @p26-notifications matches, no other parent tag matches ours, and the spec carries only ours', () => {
    // Passes before the work starts: it guards the tag against any later P26 spec.
    const specs = trackedFiles('tests/e2e').filter((file) => file.endsWith('.spec.ts') && existsSync(fromRoot(file)));
    expect(specs).toContain(SPEC);
    expect(new RegExp(parentTag(['@p26', '@p26-list']) ?? '(none)').test(E2E_TAG), 'a bare @p26 parent was not caught').toBe(true);
    const ours = tagsIn(SPEC);
    expect(ours.length).toBeGreaterThan(REQUIRED.length);
    expect(ours.filter((tag) => tag !== E2E_TAG && !tag.startsWith(`${E2E_TAG}-`)), 'the spec carries another screen’s tag').toEqual([]);
    for (const [tag] of REQUIRED) {
      expect(ours, `no journey carries ${tag}`).toContain(tag);
    }
    expect([...new Set(ours)].filter((tag) => tag !== E2E_TAG && !REQUIRED.some(([required]) => required === tag)), 'the spec carries a tag the suite does not read').toEqual([]);
    for (const file of specs.filter((name) => name !== SPEC)) {
      const theirs = tagsIn(file);
      expect(theirs.filter((tag) => new RegExp(E2E_TAG).test(tag)), `--grep ${E2E_TAG} would also run ${file}`).toEqual([]);
      const parent = parentTag(theirs);
      if (parent !== undefined) {
        expect(ours.filter((tag) => new RegExp(parent).test(tag)), `--grep ${parent} (${file}) runs these journeys`).toEqual([]);
      }
    }
  });
});

// ===========================================================================
// 6. The browser — one run of @p26-notifications
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0101 e2e run did not start', outcomes: undefined, startedAt: 0 };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

function outcomes(): E2eOutcome[] {
  expect(e2eRun.outcomes, `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-6000)}`).toBeDefined();
  return e2eRun.outcomes ?? [];
}

describe('acceptance: T-0101 — the bell and the notification centre in a browser', () => {
  beforeAll(() => {
    rmSync(OUTCOMES_FILE, { force: true });
    rmSync(fromRoot(BUDGET_RECORD), { force: true });
    // Relative to tests/e2e, where run-e2e.mjs starts Playwright.
    const reporter = relative(fromRoot('tests', 'e2e'), fromRoot('tests', 'acceptance', 'support', 'e2e-outcomes-reporter.ts')).replace(/\\/g, '/');
    const startedAt = Date.now();
    const run = spawnSync(process.execPath, [fromRoot('tests', 'e2e', 'scripts', 'run-e2e.mjs'), '--grep', E2E_TAG, `--reporter=list,${reporter}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
      timeout: E2E_RUN_TIMEOUT_MS,
      // A production build plus a Playwright list reporter overflows the
      // 1 MB default, and an overflow kills the child mid-run.
      maxBuffer: 256 * 1024 * 1024,
    });
    e2eRun = {
      status: run.status,
      output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error === undefined ? '' : `\n[spawn] ${run.error.message}`}`,
      outcomes: existsSync(OUTCOMES_FILE) ? (JSON.parse(readFileSync(OUTCOMES_FILE, 'utf8')) as E2eOutcome[]) : undefined,
      startedAt,
    };
  }, E2E_RUN_TIMEOUT_MS);

  it('runs every @p26-notifications journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(journeys.length, 'the run reported fewer @p26-notifications tests than there are behaviours').toBeGreaterThanOrEqual(REQUIRED.length);
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p26-notifications tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter((outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag));
      expect(proving.length, `no PASSING @p26-notifications test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('pins /notifications at or under 255,000 bytes and within 5% of what this run measured (I21)', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'NOTIFICATIONS_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /notifications budget is above its ceiling').toBeLessThanOrEqual(NOTIFICATIONS_BUDGET_CEILING);
    expect(budget).toBeLessThan(PRD_CEILING_BYTES);
    const record = fromRoot(BUDGET_RECORD);
    expect(existsSync(record), 'the budget test wrote no measurement').toBe(true);
    expect(statSync(record).mtimeMs, 'the measurement is older than this run').toBeGreaterThanOrEqual(e2eRun.startedAt);
    const measured = (JSON.parse(readFileSync(record, 'utf8')) as { transferredBytes: number }).transferredBytes;
    expect(measured, 'the measurement is empty').toBeGreaterThan(0);
    expect(budget, `the budget is under the ${measured} bytes measured`).toBeGreaterThanOrEqual(measured);
    expect(budget, `the budget is more than 5% over the ${measured} bytes measured — the lead re-pins NOTIFICATIONS_BUDGET_BYTES`).toBeLessThanOrEqual(Math.round(measured * BUDGET_HEADROOM));
  });
});
