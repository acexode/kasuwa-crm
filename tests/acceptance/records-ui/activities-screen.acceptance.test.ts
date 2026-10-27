import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
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
 * ACCEPTANCE — T-0083, the P07 activities screen: My tasks, the calendar,
 * meetings, snooze and reschedule (Agent 11, Frontend & Design System).
 * Decisions: D-L97, D-L98, D-L102, D-L105, D-L107, D-P13, D-P18, D-P21, D-P22.
 * Written by the lead's QA agent before the screen exists (D-L23).
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. `crm_activities`: a registered flag, DEFAULT OFF, NOT production-ready,
 *      read on the server through `lib/feature-flags.ts`. `/activities` calls
 *      `notFound()` and is gated on it by name: with every flag at its default
 *      the route is a real 404.
 *   2. The e2e harness publishes `webActivitiesUrl`. `crm_activities` RIDES ON
 *      THE RECORDS PROCESS, beside `crm_records`, `crm_accounts` and
 *      `crm_record_view`, so the screen's contact and account summaries link to
 *      records that process serves. The default server stays flagless.
 *   3. The browser reads `/api/v1/me/activities` and `/api/v1/me/calendar` and
 *      writes `/api/v1/activities` same-origin, Zod-parsed, with no scope
 *      argument. No module names a time zone: the zone is the browser's
 *      (`Intl...resolvedOptions().timeZone`), sent as `timeZone`, never a
 *      literal and never the server's guess.
 *   4. P07/01–07 against the contract mock, by e2e tag (section 6): the three
 *      buckets read once each in the browser's zone and drawn in served order
 *      with no count; three zones (Lagos, Johannesburg, Nairobi) through
 *      Playwright's `timezoneId`, with the browser clock fixed at an instant
 *      that is a different DAY in each; keyset "more" per bucket; the week and
 *      month views, windows from local midnights and never over 42 days, every
 *      page of a window read; composing a task and a meeting for the caller,
 *      one target picked by name, with the meeting rules checked before
 *      anything is sent; complete, snooze and reschedule sending `version` plus
 *      only what changed; a second save after a 409 that rebases (D-L102),
 *      through two 409s in a row; a 403 `field_not_editable` as its own
 *      message; withheld times and fields as locks, never guesses; links only
 *      from well-formed uuids; loading, empty and failed kept apart; offline
 *      with every write disabled and nothing queued or stored; the design's
 *      out-of-contract features hidden; 360 px; en-XA; the byte budget.
 *   5. i18n: the literal-string rule fires on the route; every message id the
 *      slice names is in every design-menu catalogue, with a label for each
 *      bucket, for the task and meeting types, for `field_not_editable` and for
 *      each meeting-time rule; every error the four operations answer is
 *      localised; no language falls off the menu (D-P1).
 *   6. No colour literal (wider than the lint rule, D-L84) and no
 *      device-storage API in the slice.
 *   7. D-L105's debt: `lib/contact-record-api.ts` accepts the `meeting` type,
 *      because the meetings this screen creates reach the record timelines.
 *
 * PINNED INTERFACES (the builder's side): the DOM hooks and the
 * `webActivitiesUrl` stack key listed in the header of
 * `tests/e2e/p07-activities.spec.ts`; the route file
 * `apps/web/app/(group)/activities/page.tsx`; a P07 screen in the slice
 * (`data-screen="P07"`); bucket labels under ids ending `.bucket.<code>`; type
 * labels under an id containing `activit` and ending `.type.<code>` (the
 * `record.activity.type.*` keys count); a `field_not_editable` message under an
 * id ending `.field_not_editable` or `.fieldNotEditable`; each meeting-time
 * rule under an id about activities, meetings or the calendar ending
 * `.required` (or `.endsRequired`), `.invalid_range` (or `.invalidRange`) and
 * `.too_long` (or `.tooLong`).
 *
 * BUILDER'S CHOICES: the layout (desktop week and month, the 360 px agenda);
 * whether the calendar loads on first open (`next/dynamic`); the snooze presets
 * (at least one, each a later time); whether events drag (the reschedule form
 * is the control, WCAG 2.2 SC 2.5.7); whether the composer also offers notes
 * and calls; whether Kasuwa-to-Kasuwa overlaps are flagged (no external
 * calendar is read, so "clash" copy about Google or Microsoft is out); where
 * the activities client lives; the copy.
 *
 * THE SLICE. Every apps/web module the `/activities` route directory imports,
 * transitively by relative import, except the shared shells
 * (`components/auth`, `components/crm`, `components/admin`), which other
 * suites hold. Shared record pieces it reuses (`components/record`,
 * `components/records`) are in the slice and held to the same rules. It must
 * contain the P07 screen itself.
 *
 * NOT HELD HERE, AND WHY
 *   - "Non-writers see no write controls": D-L84, the capability-read gap
 *     (T-0079). Write controls show to every caller and the API's 403 is the
 *     gate; a row whose own fields say the caller cannot write it (a withheld
 *     completion) offers no complete.
 *   - Clearing a due time (`dueAt: null`) and reassigning: allowed by the
 *     contract, not asked for by T-0083; if built, the mock holds them to the
 *     same only-what-changed rule.
 *   - Dragging: not driven here. If built it sends what the form sends.
 *
 * THE BROWSER HALF. `tests/e2e/p07-activities.spec.ts` (journeys) and
 * `tests/e2e/support/activities-mock.ts` (the contract mock, which checks
 * every answer it gives against the YAML) were written with this suite and are
 * PINNED by hash below, because `tests/e2e` is not path-protected (D-L64).
 * ACTIVITIES_BUDGET_BYTES is the one line that may change without a re-pin,
 * and only towards the measurement (section 6): it is provisional, the builder
 * measures it and the lead re-pins it.
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p07 --reporter=list,<ours>
 *
 * spawned with `shell: false` and the arguments as an array (D-L62). Every
 * test is read from the outcomes file our reporter writes, so a skipped,
 * `fixme`d or unmatched test never counts. No other spec's tag contains
 * `@p07`, and it contains no other screen's parent tag (section 5, D-L84).
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const FLAG = 'crm_activities';
/** The flags of the records process that `crm_activities` rides on. */
const RECORDS_PROCESS_FLAGS = ['crm_records', 'crm_accounts', 'crm_record_view'];

const E2E_TAG = '@p07';

/** Every other screen's parent tag. None may contain ours, and ours may contain none (D-L84). */
const OTHER_PARENT_TAGS = ['@p01', '@p02', '@p02-live', '@p04', '@p04-accounts', '@p05-contact', '@p05-account', '@leads-p04', '@harness'];

/** `next build` (SWC wasm on the dev host, D-L62), a container, the servers and the journeys. */
const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p07-activities.spec.ts';
const MOCK = 'tests/e2e/support/activities-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/p07-budget.json';
const CONTRACT = 'docs/api/records.openapi.yaml';

/**
 * The pinned browser half (CRLF folded to LF; the budget literal normalised).
 * A change to either file is a change to the acceptance contract: the lead
 * re-pins it, the builder does not.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  // D-L118: the two budget journeys no longer fix the clock (it hid first-contentful-paint).
  [SPEC]: '55df87dc4b0ae7d40c8fb8cab035b57101d7af356b5ce91beb23106d06949e31',
  // T-0091 (lead re-pin): the mock answers listCustomFields (empty unless a journey sets custom fields) and checks a create's `custom`.
  [MOCK]: 'a2fbc3e89c4f55c866a5fec135e1e26132d559e463c36a5c0c345f7ae29599f5',
};

/** Provisional (see the budget test in the spec). Never above this. */
const ACTIVITIES_BUDGET_CEILING = 275_000; // D-L203: T-0145 measured, after removing the weight it could (no visual change)

/** Re-pinned within 5% of what the run measured, like /leads (T-0058) and P01/1 (T-0035). */
const BUDGET_HEADROOM = 1.05;

const PRD_CEILING_BYTES = 300 * 1024;

/** The zones the journeys run in, each a separate passing test. */
const ZONES = ['Africa/Lagos', 'Africa/Johannesburg', 'Africa/Nairobi'];

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the mock's validators
  // reject malformed requests and answers, so every afterEach "no violations"
  // and "no mock faults" means something.
  ['@p07-mock', 'the contract mock refuses what the contract and the screen’s rules refuse, and checks its own answers'],
  // Passes before the work starts too (there is no route at all): a negative
  // invariant, given meaning by @p07-flag-on.
  ['@p07-flag-off', '/activities is a 404 with crm_activities at its default, and the browser cannot flip it'],
  ['@p07-flag-on', '/activities renders My tasks with crm_activities on'],
  ['@p07-shell', 'the CRM shell, Activities current in its nav, no link a 404'],
  ['@p07-buckets', 'overdue, today, upcoming: each read once in the browser’s zone, served order, named not counted, axe-clean'],
  ['@p07-markup', 'a subject with markup is drawn as text'],
  ['@p07-paging', 'a bucket pages by keyset "more", cursor echoed and out of the URL, no count'],
  ['@p07-zones', 'Lagos, Johannesburg and Nairobi: timeZone sent, buckets, times, the week and the form in the zone'],
  ['@p07-calendar-week', 'the week: seven days from a local midnight, events on their local day, meetings with both times'],
  ['@p07-calendar-month', 'the month covers the local month in at most 42 days; paging months never exceeds it'],
  ['@p07-calendar-paging', 'every page of a busy window read, each cursor echoed for the same window'],
  ['@p07-compose-task', 'a task for the caller, one contact by name, its due time in UTC from the zone'],
  ['@p07-compose-meeting', 'a meeting for the caller, one account by name, both times in UTC, then on the calendar'],
  ['@p07-compose-validation', 'a missing time, an end at or before the start, over 24 h: a message each, nothing sent; 24 h exactly allowed'],
  ['@p07-complete', 'complete sends exactly { version, completed }, not optimistic, no Undo'],
  ['@p07-snooze', 'a snooze preset and a chosen time send exactly { version, dueAt }'],
  ['@p07-reschedule', 'a resize sends only endsAt, a move only the times, from a form prefilled in the zone'],
  ['@p07-stale', 'after a 409 the screen re-reads and rebases; an untouched field is never sent; a shared change is noted'],
  ['@p07-not-editable', 'a 403 field_not_editable is its own message, never retried'],
  ['@p07-locked', 'withheld subject, account link and completion are locks; a withheld time is never guessed'],
  ['@p07-links', 'summaries link only from well-formed uuids, URL-encoded; no UUID printed'],
  ['@p07-states', 'loading, empty and failed are distinct, for the buckets and the calendar'],
  ['@p07-offline', 'offline: every write disabled, nothing sent, queued or stored on the device'],
  ['@p07-hidden', 'no priority, bulk, Undo, external calendars, holidays, AI brief, booking, check-in, reminders or counts'],
  ['@p07-mobile', '360 px: no sideways scroll, axe-clean, both views'],
  ['@p07-pseudo', 'en-XA renders pseudo text on My tasks, the calendar and the composer'],
  ['@p07-budget', '/activities inside its byte budget on the production build'],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SourceFile {
  file: string;
  source: string;
}

function trackedFiles(directory: string): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', directory], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function webSources(): SourceFile[] {
  return trackedFiles('apps/web')
    .filter((file) => /\.(tsx?|mjs)$/.test(file) && !/\.test\.tsx?$/.test(file) && existsSync(fromRoot(file)))
    .map((file) => ({ file, source: readFileSync(fromRoot(file), 'utf8') }));
}

/** The App Router page for `/activities` (a route group such as `(crm)` allowed). */
function activitiesPage(): string | undefined {
  return trackedFiles('apps/web/app').find((file) => /^apps\/web\/app\/(?:\([\w-]+\)\/)*activities\/page\.tsx$/.test(file));
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Shared shells other suites hold; not part of this slice. */
const SHARED_SHELLS = ['apps/web/components/auth/', 'apps/web/components/crm/', 'apps/web/components/admin/'];

/**
 * The slice: every file in the route directory, and everything they import by
 * a relative path, transitively, minus the shared shells.
 */
function sliceSources(): SourceFile[] {
  const page = activitiesPage();
  if (page === undefined) {
    return [];
  }
  const sources = new Map(webSources().map((entry) => [entry.file, entry.source]));
  const routeDirectory = posix.dirname(page);
  const queue = [...sources.keys()].filter((file) => file.startsWith(`${routeDirectory}/`));
  const seen = new Set<string>();
  const resolveImport = (from: string, specifier: string): string | undefined => {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    return [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) =>
      sources.has(candidate),
    );
  };
  while (queue.length > 0) {
    const file = queue.shift() ?? '';
    if (seen.has(file) || SHARED_SHELLS.some((shell) => file.startsWith(shell))) {
      continue;
    }
    seen.add(file);
    const code = withoutComments(sources.get(file) ?? '');
    const specifiers = [
      ...code.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g),
      ...code.matchAll(/\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g),
      ...code.matchAll(/\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g),
    ].map((match) => match[1] ?? '');
    for (const specifier of specifiers) {
      const target = resolveImport(file, specifier);
      if (target !== undefined && !seen.has(target)) {
        queue.push(target);
      }
    }
  }
  return [...seen].sort().map((file) => ({ file, source: sources.get(file) ?? '' }));
}

/** The slice, refused unless it contains the P07 screen itself. */
function screenSlice(): SourceFile[] {
  const slice = sliceSources();
  expect(activitiesPage(), 'there is no apps/web/app/**/activities/page.tsx').toBeDefined();
  expect(
    slice.filter(({ source }) => /['"`]P07['"`]/.test(withoutComments(source))).map(({ file }) => file),
    'the /activities route imports no P07 screen (data-screen="P07")',
  ).not.toEqual([]);
  return slice;
}

/** apps/web/lib modules that read the caller's activities or calendar. */
function activityClients(): SourceFile[] {
  return webSources().filter(
    ({ file, source }) => file.startsWith('apps/web/lib/') && /\/api\/v1\/me\/(activities|calendar)/.test(withoutComments(source)),
  );
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8')) as Record<string, string>;
}

const BUDGET_LITERAL = /const ACTIVITIES_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(BUDGET_LITERAL, 'const ACTIVITIES_BUDGET_BYTES = <budget>;');
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

type Json = Record<string, unknown>;

interface Contract {
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string }> }>>;
  components: { responses: Record<string, Json>; schemas: Record<string, Json> };
}

function contract(): Contract {
  return parse(readFileSync(fromRoot(CONTRACT), 'utf8')) as Contract;
}

/** Error `code`s an operation can answer with, from the contract's examples. */
function errorCodes(path: string, method: string): string[] {
  const spec = contract();
  const operation = spec.paths[path]?.[method];
  expect(operation, `${method.toUpperCase()} ${path} is gone from the records contract`).toBeDefined();
  const codes = new Set<string>();
  for (const [status, response] of Object.entries(operation?.responses ?? {})) {
    if (status.startsWith('2') || typeof response.$ref !== 'string') {
      continue;
    }
    const name = response.$ref.split('/').at(-1) ?? '';
    const body = (spec.components.responses[name]?.content as Json | undefined)?.['application/json'] as
      | { example?: { code?: string }; examples?: Record<string, { value?: { code?: string } }> }
      | undefined;
    for (const example of [body?.example, ...Object.values(body?.examples ?? {}).map((entry) => entry.value)]) {
      if (typeof example?.code === 'string') {
        codes.add(example.code);
      }
    }
  }
  return [...codes].sort();
}

function enumAt(schemaName: string, ...path: string[]): string[] {
  let node: unknown = contract().components.schemas[schemaName];
  for (const segment of path) {
    node = (node as Json | undefined)?.[segment];
  }
  return Array.isArray(node) ? node.map(String) : [];
}

/**
 * Colour written into a web source rather than read from a token: a hex value
 * anywhere in a string, a CSS colour function, a Tailwind arbitrary colour, a
 * Tailwind default-palette class, or an inline style colour (D-L84: the lint
 * rule sees only a string that IS a hex value). The design's event tints are
 * `color-mix(...)` of chart tokens: in apps/web that is a literal too, and
 * belongs in `packages/ui` as a token.
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

/**
 * A time zone written into a source: an IANA name in a string, or a literal
 * `timeZone:` value. The zone is the browser's, read at run time.
 */
function zoneLiterals(source: string): string[] {
  const code = withoutComments(source);
  return [
    ...(code.match(/['"`](?:Africa|Europe|America|Asia|Atlantic|Indian|Pacific|Australia|Antarctica|Etc)\/[A-Za-z0-9_+-]+['"`]/g) ?? []),
    ...(code.match(/\btimeZone\s*:\s*['"`][^'"`]*['"`]/g) ?? []),
  ];
}

/** ESLint from the workspace root, run as node with no shell. */
function eslint(args: readonly string[], input?: string): { status: number | null; output: string } {
  const require = createRequire(fromRoot('package.json'));
  const bin = resolve(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
  const run = spawnSync(process.execPath, [bin, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error?.message ?? ''}` };
}

/** The exported readers in lib/feature-flags.ts whose body evaluates `flag` by name. */
function readersOf(flag: string): string[] {
  const flagModule = withoutComments(readFileSync(fromRoot('apps/web/lib/feature-flags.ts'), 'utf8'));
  const named = new RegExp(`['"]${flag}['"]`);
  return [...flagModule.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)]
    .filter((match) => named.test(match[2] ?? ''))
    .map((match) => match[1] ?? '');
}

/** The test tags in a spec's code (titles and annotations), comments and package scopes excluded. */
function tagsIn(file: string): string[] {
  return [...withoutComments(readFileSync(fromRoot(file), 'utf8')).matchAll(/@[a-z0-9][\w-]*/gi)]
    .map((match) => match[0])
    .filter((tag) => /^@(p\d|leads|harness)/i.test(tag));
}

/** en.json labels for a code, under an id about activities, meetings or the calendar. */
function meetingRuleKey(en: Record<string, string>, codes: readonly string[]): string | undefined {
  return Object.keys(en).find((id) => /activit|meeting|calendar/i.test(id) && codes.some((code) => id.endsWith(`.${code}`)));
}

// ===========================================================================
// 1. The flag, the route, the harness and the clients
// ===========================================================================

describe('acceptance: T-0083 — crm_activities exists, is off, is not production-ready, and gates /activities', () => {
  it('registers crm_activities, not production-ready, and it evaluates OFF by default', async () => {
    // `true` as the fallback on purpose: an unregistered flag returns the
    // fallback, so only a flag that is registered AND defaults off answers false.
    expect(Object.keys(FLAGS), `${FLAG} is not declared in FLAGS`).toContain(FLAG);
    const definition = (FLAGS as Readonly<Record<string, { productionReady?: boolean; defaultValue?: boolean }>>)[FLAG];
    expect(definition?.defaultValue, `${FLAG} does not default off`).toBe(false);
    expect(definition?.productionReady, `${FLAG} is marked production-ready`).toBe(false);
    await initialiseFeatureFlags();
    const value = await featureFlagClient().getBooleanValue(FLAG, true, toEvaluationContext({ tenantId: 'acceptance-probe' }));
    expect(value, `${FLAG} does not evaluate OFF by default`).toBe(false);
  });

  it('has a route file that calls notFound() on crm_activities, read on the server only', () => {
    const page = activitiesPage();
    expect(page, 'there is no apps/web/app/**/activities/page.tsx').toBeDefined();
    const source = withoutComments(readFileSync(fromRoot(page ?? 'missing'), 'utf8'));
    expect(source, `${page} does not call notFound()`).toMatch(/\bnotFound\s*\(/);
    expect(source, `${page} imports nothing from lib/feature-flags`).toMatch(/from ['"][./]*lib\/feature-flags['"]/);
    // A dedicated reader, or a generic one called with the name. crmLiveNav
    // (the shell's nav) may name the flag too, but it is not a gate.
    const readers = readersOf(FLAG).filter((name) => name !== 'crmLiveNav');
    const gated = readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source)) || new RegExp(`['"]${FLAG}['"]`).test(source);
    expect(gated, `${page} is not gated on ${FLAG} (readers found: ${readers.join(', ') || 'none'})`).toBe(true);
    const clientEvaluators = webSources().filter(({ source: code }) => /^\s*['"]use client['"]/m.test(code) && code.includes(FLAG));
    expect(clientEvaluators.map(({ file }) => file), 'a client module names crm_activities — flags are read on the server only').toEqual([]);
  });

  it('serves the journeys from the records process with crm_activities on, publishes webActivitiesUrl, and leaves the default server flagless', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    const processes = [...runner.matchAll(/KASUWA_FEATURE_FLAGS_ON:\s*['"`]([^'"`]*)['"`]/g)].map((match) => (match[1] ?? '').split(/[,\s]+/));
    expect(
      processes.some((flags) => flags.includes(FLAG) && RECORDS_PROCESS_FLAGS.every((flag) => flags.includes(flag))),
      `no web process in run-e2e.mjs carries ${FLAG} beside ${RECORDS_PROCESS_FLAGS.join(', ')}`,
    ).toBe(true);
    expect(runner, 'run-e2e.mjs does not publish webActivitiesUrl in the stack file').toContain('webActivitiesUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*''/);
  });

  it('reads activities and the calendar same-origin, Zod-parsed, with no scope argument and no zone of its own', () => {
    const clients = activityClients();
    const reading = (path: string) => clients.filter(({ source }) => withoutComments(source).includes(path)).map(({ file }) => file);
    expect(reading('/api/v1/me/activities'), 'no apps/web/lib module reads /api/v1/me/activities').not.toEqual([]);
    expect(reading('/api/v1/me/calendar'), 'no apps/web/lib module reads /api/v1/me/calendar').not.toEqual([]);
    for (const { file, source } of clients) {
      const code = withoutComments(source);
      expect(code, `${file} names an absolute API origin`).not.toMatch(/https?:\/\/[^'"`]*\/api\/v1/);
      expect(code, `${file} does not parse with Zod`).toMatch(/from ['"]zod['"]/);
      // A programme or an owner in a query string, a header or a list of them is scope from the client.
      expect(code, `${file} builds a scope argument`).not.toMatch(
        /programmeIds|ownerUserIds|(set|append)\(\s*['"`](programme|owner)|['"`]x-[\w-]*(programme|tenant)/i,
      );
      expect(zoneLiterals(source), `${file} names a time zone: the zone is the browser's`).toEqual([]);
    }
    for (const { file: name, source } of webSources()) {
      expect(withoutComments(source), `${name} imports test support`).not.toMatch(
        /from ['"][^'"]*(tests\/e2e|activities-mock|records-mock|@kasuwa\/testing)[^'"]*['"]/,
      );
    }
  });

  it('takes the zone from the browser, and the slice writes none of its own', () => {
    const slice = screenSlice();
    const everything = [...slice, ...activityClients()];
    expect(
      everything.some(({ source }) => /\bresolvedOptions\s*\(\s*\)/.test(withoutComments(source))),
      'nothing in the slice or the activities client reads Intl.DateTimeFormat().resolvedOptions().timeZone',
    ).toBe(true);
    const found = everything.flatMap(({ file, source }) => zoneLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'a time zone is written into the slice: "always WAT" is the design, not the rule').toEqual([]);
  });

  it('accepts meeting wherever an activity type is parsed for the record timelines (D-L105)', () => {
    // NOTE: may pass before the work starts, if T-0082 lands first; T-0083
    // creates meetings, so it must hold by the time this screen ships.
    const recordClient = withoutComments(readFileSync(fromRoot('apps/web/lib/contact-record-api.ts'), 'utf8'));
    expect(recordClient, 'lib/contact-record-api.ts no longer parses an activity type').toMatch(/['"]note['"][\s\S]{0,200}['"]call['"]/);
    expect(recordClient, 'lib/contact-record-api.ts parses ActivityType without meeting').toMatch(/['"]meeting['"]/);
  });
});

// ===========================================================================
// 2. i18n — the lint rule, every catalogue, D-P1
// ===========================================================================

describe('acceptance: T-0083 — every string through i18n, in every catalogue, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the /activities route file', () => {
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(
      /files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/,
    );
    // A rule only ever seen passing proves nothing: plant a literal at the route's own path.
    const page = activitiesPage();
    expect(page, 'there is no apps/web/app/**/activities/page.tsx').toBeDefined();
    const planted = eslint(
      ['--stdin', '--stdin-filename', page ?? 'apps/web/app/activities/page.tsx', '--format', 'json'],
      'export default function Planted() {\n  return <p>Snooze to tomorrow</p>;\n}\n',
    );
    expect(planted.output, `a literal JSX string at ${page} is not rejected:\n${planted.output.slice(-2000)}`).toContain('i18next/no-literal-string');
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const slice = screenSlice();
    const run = eslint(['--max-warnings', '0', ...slice.map(({ file }) => file)]);
    expect(run.status, `eslint fails on the activities slice:\n${run.output.slice(-4000)}`).toBe(0);
    // jsx-text-only cannot see attributes; an English aria-label is still English.
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('puts every message the slice names, and a label for each bucket, type, field_not_editable and meeting rule, in every design-menu catalogue', async () => {
    const i18n: { DESIGN_MENU_LOCALES: readonly string[] } = await import(fromRoot('packages/i18n/src/index.ts'));
    const en = catalogue('en');
    const slice = screenSlice();

    const named = new Set<string>();
    for (const { source } of slice) {
      for (const match of withoutComments(source).matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)) {
        if (match[1] !== undefined && en[match[1]] !== undefined) {
          named.add(match[1]);
        }
      }
    }
    // Vacuity guard: a slice that names almost no catalogue key is not using i18n.
    expect(named.size, 'the activities slice names almost no message id').toBeGreaterThan(15);

    const find = (what: string, matches: (id: string) => boolean): string => {
      const key = Object.keys(en).find(matches);
      expect(key, `en.json has no label for ${what}`).toBeDefined();
      return key ?? `<missing ${what}>`;
    };
    const buckets = enumAt('ActivityBucket', 'enum');
    expect(buckets, 'the contract lists no buckets').toEqual(['overdue', 'today', 'upcoming']);
    const bucketKeys = buckets.map((code) => find(`the ${code} bucket (an id ending ".bucket.${code}")`, (id) => id.endsWith(`.bucket.${code}`)));
    const listed = enumAt('MyActivity', 'properties', 'type', 'enum');
    expect(listed).toEqual(['task', 'meeting']);
    const typeKeys = listed.map((type) =>
      find(`the ${type} activity type (an id containing "activit", ending ".type.${type}")`, (id) => /activit/i.test(id) && id.endsWith(`.type.${type}`)),
    );
    const refusalKey = find('field_not_editable (an id ending ".field_not_editable" or ".fieldNotEditable")', (id) =>
      id.endsWith('.field_not_editable') || id.endsWith('.fieldNotEditable'),
    );
    const ruleKeys = (
      [
        ['a missing meeting time', ['required', 'Required', 'endsRequired', 'endRequired']],
        ['an end at or before the start', ['invalid_range', 'invalidRange']],
        ['a meeting over 24 hours', ['too_long', 'tooLong']],
      ] as const
    ).map(([what, codes]) => {
      const key = meetingRuleKey(en, codes);
      expect(key, `en.json has no label for ${what} under an activities, meeting or calendar id ending .${codes.join(' or .')}`).toBeDefined();
      return key ?? `<missing ${what}>`;
    });

    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const key of [...named, ...bucketKeys, ...typeKeys, refusalKey, ...ruleKeys]) {
        if (typeof messages[key] !== 'string' || messages[key].trim() === '') {
          missing.push(`${locale}: ${key}`);
        }
      }
    }
    expect(missing, 'message ids the activities screen uses that a catalogue lacks').toEqual([]);
  });

  it('localises every error the four P07 operations can answer with', () => {
    // NOTE: passes before the work starts — T-0042 added records.error.* for
    // every shared code. It is here so a new code in the contract (or a
    // dropped key) fails this suite rather than reaching a user as a raw code.
    const en = catalogue('en');
    const codes = new Set([
      ...errorCodes('/api/v1/me/activities', 'get'),
      ...errorCodes('/api/v1/me/calendar', 'get'),
      ...errorCodes('/api/v1/activities', 'post'),
      ...errorCodes('/api/v1/activities/{activityId}', 'patch'),
    ]);
    expect([...codes], 'the P07 operations declare no error codes').toEqual(
      expect.arrayContaining(['not_found', 'not_permitted', 'stale_write', 'validation_failed']),
    );
    const missing = [...codes].filter((code) => en[`records.error.${code}`] === undefined);
    expect(missing, 'en.json lacks records.error.<code> for these errors').toEqual([]);
  });

  it('drops no design-menu language from the menu (D-P1)', async () => {
    // Passes before the work starts: it guards against the work, not for it.
    const i18n: { DESIGN_MENU_LOCALES: readonly string[]; MENU_LOCALES: readonly string[] } = await import(
      fromRoot('packages/i18n/src/index.ts')
    );
    expect(i18n.DESIGN_MENU_LOCALES.length).toBeGreaterThan(1);
    const dropped = i18n.DESIGN_MENU_LOCALES.filter((locale) => !i18n.MENU_LOCALES.includes(locale));
    expect(dropped, 'these languages fell off the menu — translate the new keys in every catalogue').toEqual([]);
  });
});

// ===========================================================================
// 3. Colour, and the device
// ===========================================================================

describe('acceptance: T-0083 — no colour literal and no device storage in the slice', () => {
  it('the colour and zone detectors catch what the lint rule misses', () => {
    // Planted first: a detector only ever seen finding nothing proves nothing.
    for (const planted of [
      'className="text-[#c00] p-2"',
      "style={{ color: 'red' }}",
      'className="bg-red-500"',
      "const tint = 'color-mix(in oklch, var(--k-chart-1) 18%, var(--k-surface))';",
      'className="border-white"',
    ]) {
      expect(colourLiterals(planted), `the detector missed ${planted}`).not.toEqual([]);
    }
    expect(colourLiterals('className="bg-surface text-text-2 border-border-strong text-danger-text"')).toEqual([]);
    for (const planted of ["const zone = 'Africa/Lagos';", "new Intl.DateTimeFormat('en', { timeZone: 'UTC' })", 'const z = `Etc/GMT-1`;']) {
      expect(zoneLiterals(planted), `the zone detector missed ${planted}`).not.toEqual([]);
    }
    expect(zoneLiterals('const zone = Intl.DateTimeFormat().resolvedOptions().timeZone; f({ timeZone: zone });')).toEqual([]);
  });

  it('the slice reaches the screen through its imports, and stops at the shared shells', () => {
    const slice = screenSlice();
    const files = slice.map(({ file }) => file);
    expect(files).toContain(activitiesPage() ?? '<no page>');
    expect(files.filter((file) => SHARED_SHELLS.some((shell) => file.startsWith(shell)))).toEqual([]);
    expect(files.length, 'the slice is the route file alone: nothing it imports was followed').toBeGreaterThan(1);
  });

  it('writes no colour literal anywhere in the slice', () => {
    const found = screenSlice().flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the activities slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('touches no device-storage API (D-L64, D-P21)', () => {
    const storage = /\b(localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|navigator\.storage|document\.cookie)\b/;
    const found = [...screenSlice(), ...activityClients()].filter(({ source }) => storage.test(withoutComments(source))).map(({ file }) => file);
    expect(found, 'the activities slice uses a device-storage API: the lists live in memory only').toEqual([]);
  });
});

// ===========================================================================
// 4. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0083 — the journeys and the mock are the ones this suite was written with', () => {
  it('pins p07-activities.spec.ts and activities-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(
        normalisedHash(file),
        `${file} changed. It is part of the T-0083 acceptance contract: ask the lead to re-pin it ` +
          '(only ACTIVITIES_BUDGET_BYTES may move without that).',
      ).toBe(pinned);
    }
    const mock = readFileSync(fromRoot(MOCK), 'utf8');
    expect(mock, 'the mock no longer reads the records contract').toContain(CONTRACT);
    expect(mock, 'the mock no longer checks its own answers against the contract').toMatch(/answerProblems\(operation, status, body\)/);
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    expect(spec, 'the journeys no longer fix the browser clock').toContain('page.clock.setFixedTime(new Date(NOW))');
    for (const zone of ZONES) {
      expect(spec, `the journeys no longer run in ${zone}`).toContain(`'${zone}'`);
    }
  });
});

// ===========================================================================
// 5. The tag is this screen's alone (D-L84)
// ===========================================================================

describe('acceptance: T-0083 — @p07 selects these journeys and nothing else', () => {
  it('no other spec carries a tag @p07 matches, ours matches no other parent tag, and the spec carries only ours', () => {
    // Passes before the work starts: it guards later screens against
    // colliding with this one, as `@p04` once collided with `@p04-accounts`.
    const specs = trackedFiles('tests/e2e').filter((file) => file.endsWith('.spec.ts') && existsSync(fromRoot(file)));
    expect(specs).toContain(SPEC);
    const ours = tagsIn(SPEC);
    expect(ours.length).toBeGreaterThan(REQUIRED.length);
    expect(ours.filter((tag) => tag !== E2E_TAG && !tag.startsWith(`${E2E_TAG}-`)), 'the spec carries another screen’s tag').toEqual([]);
    const clashes = specs
      .filter((file) => file !== SPEC)
      .flatMap((file) => tagsIn(file).filter((tag) => new RegExp(E2E_TAG).test(tag)).map((tag) => `${file}: ${tag}`));
    expect(clashes, `--grep ${E2E_TAG} would also run these`).toEqual([]);
    for (const other of OTHER_PARENT_TAGS) {
      expect(new RegExp(other).test(E2E_TAG), `--grep ${other} runs this screen`).toBe(false);
      expect(ours.filter((tag) => new RegExp(other).test(tag)), `--grep ${other} runs these journeys`).toEqual([]);
    }
  });
});

// ===========================================================================
// 6. The browser — one run of @p07
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0083 e2e run did not start', outcomes: undefined, startedAt: 0 };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

function outcomes(): E2eOutcome[] {
  expect(e2eRun.outcomes, `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-6000)}`).toBeDefined();
  return e2eRun.outcomes ?? [];
}

describe('acceptance: T-0083 — the activities screen in a browser', () => {
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

  it('runs every @p07 journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(journeys.length, 'the run reported fewer @p07 tests than there are behaviours').toBeGreaterThanOrEqual(REQUIRED.length);
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p07 tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter((outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag));
      expect(proving.length, `no PASSING @p07 test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  for (const zone of ZONES) {
    it(`proves the screen in ${zone} (@p07-zones)`, () => {
      const proving = outcomes().filter((outcome) => passed(outcome) && outcome.tags.includes('@p07-zones') && outcome.title.includes(zone));
      expect(proving.length, `no PASSING @p07-zones test ran in ${zone}`).toBeGreaterThan(0);
    });
  }

  it('pins /activities at or under 255,000 bytes and within 5% of what this run measured', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'ACTIVITIES_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /activities budget is above its ceiling').toBeLessThanOrEqual(ACTIVITIES_BUDGET_CEILING);
    expect(budget).toBeLessThan(PRD_CEILING_BYTES);

    const record = fromRoot(BUDGET_RECORD);
    expect(existsSync(record), 'the budget test wrote no measurement').toBe(true);
    expect(statSync(record).mtimeMs, 'the measurement is older than this run').toBeGreaterThanOrEqual(e2eRun.startedAt);
    const measured = (JSON.parse(readFileSync(record, 'utf8')) as { transferredBytes: number }).transferredBytes;
    expect(measured, 'the measurement is empty').toBeGreaterThan(0);
    expect(budget, `the budget is under the ${measured} bytes measured`).toBeGreaterThanOrEqual(measured);
    expect(budget, `the budget is more than 5% over the ${measured} bytes measured — re-pin ACTIVITIES_BUDGET_BYTES`).toBeLessThanOrEqual(
      Math.round(measured * BUDGET_HEADROOM),
    );
  });
});
