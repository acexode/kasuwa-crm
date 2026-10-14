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
 * ACCEPTANCE — T-0087, global search and the command palette (P27; Agent 11,
 * Frontend & Design System), against T-0085's contract (`searchRecords`,
 * `lookupRecords`). Decisions: D-L133 (and the contract suite's R1–R22),
 * ADR-0014, D-L128, D-P13, D-L87, D-L68, D-L80, D-L115, D-L118.
 * Written by the lead's QA agent before the screen exists (D-L23).
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. `crm_search`: a registered flag, DEFAULT OFF, NOT production-ready,
 *      read on the server through `lib/feature-flags.ts`. `/search` calls
 *      `notFound()` and is gated on it by name, so with every flag at its
 *      default it is a real 404. No client module names it. The CRM shell's
 *      search entry and the palette exist only where it is on (R2).
 *   2. The e2e harness publishes `webSearchUrl`; `crm_search` RIDES ON THE
 *      RECORDS PROCESS, beside `crm_records`, `crm_accounts`,
 *      `crm_record_view` and `crm_leads`, so hits and "see all" resolve (R3).
 *   3. The browser calls searchRecords and lookupRecords same-origin,
 *      Zod-parsed, with no scope argument, the lookup as a POST, no
 *      identifier ever in a query string; no apps/web module imports test
 *      support.
 *   4. The palette and the screen against the contract mock, by e2e tag
 *      (section 6): the dialog and its keyboard; grouped hits; "see all";
 *      debounce, minimum length and latest-wins; R21 on the client (phone and
 *      email only to the lookup, never in a URL, history entry or link);
 *      partial identifiers refused; only served fields; links; states; an
 *      unreadable type; an unknown type; nothing on the device; the
 *      overruled design absent; 360 px; en-XA; the byte budget.
 *   5. i18n: the literal-string rule fires on the route; every message id the
 *      slice names is in every design-menu catalogue, with a label for each
 *      group type and for invalid_phone and invalid_email; every error the two
 *      operations answer is localised; no language falls off the menu.
 *   6. No colour literal (wider than the lint rule, D-L84) and no
 *      device-storage API in the slice or the search client.
 *
 * PINNED INTERFACES (the builder's side)
 *
 *   - The DOM hooks and the `webSearchUrl` stack key listed in the header of
 *     `tests/e2e/p27-search.spec.ts`.
 *   - The route file `apps/web/app/(group)/search/page.tsx`, holding a P27
 *     screen (`data-screen="P27"`); a palette module in the slice holding
 *     `data-testid="command-palette"`.
 *   - `crmLiveNav()` lists `'search'` exactly when `crm_search` is on, and
 *     `components/crm/crm-shell.tsx` decides by `live.includes('search')`
 *     whether to draw the header entry `a[href="/search"]` and mount the
 *     palette.
 *   - A search client in `apps/web/lib/` naming `/api/v1/search` and the
 *     lookup path.
 *   - Labels under ids containing `search` or `palette`, ending
 *     `.group.<contact|lead|account|deal>`, `.invalid_phone` (or
 *     `.invalidPhone`) and `.invalid_email` (or `.invalidEmail`);
 *     `records.error.<code>` for every error code of the two operations.
 *
 * RULINGS (R1–R26; where the task file, the contract or the design leave a
 * choice open, the suite is written to these)
 *
 *   R1. Surfaces. `/search` is the P27 screen: the search panel inline (A1
 *       grouped hits, A2 lookups, A4 searching, A5 no matches), not a dialog.
 *       The palette is the same panel in a dialog (D1's record rows only).
 *       Both use one search client. Frames A, A3, B, B1, C, C1, D, D2 and D3
 *       are not served and not built.
 *   R2. Flag and entry. `crmLiveNav()` lists `search` exactly when
 *       `crm_search` is on; the shell draws its header entry
 *       (`a[href="/search"]`, current on /search) and mounts the palette only
 *       when `live.includes('search')`. No process serves the shell with the
 *       flag off, so "no palette and no entry with it off" is held statically
 *       (section 1); the default server's 404 and its dead Ctrl+K are held in
 *       the browser.
 *   R3. Harness. NOT WIRED BY THIS SUITE: the builder adds `crm_search` to the
 *       records process and `webSearchUrl` to the stack file in the change
 *       that registers the flag. Naming an unregistered flag in
 *       KASUWA_FEATURE_FLAGS_ON stops a web process booting, which would take
 *       every records-process suite down on main (as T-0109's R3).
 *   R4. Opening. Control+K and Meta+K open the palette on every CRM screen,
 *       with focus anywhere, a text field of the screen included. Focus moves
 *       to the palette's search box. Escape closes it and focus returns to
 *       where it was.
 *   R5. The dialog: `role="dialog"`, `aria-modal="true"`, an accessible name,
 *       and a focus trap (Tab and Shift+Tab never leave it).
 *   R6. The combobox pattern (ARIA 1.2). The input is `role="combobox"` with
 *       `aria-controls` naming a named `role="listbox"`; each hit is
 *       `role="option"` with a unique id (a lead is in two groups: the ids
 *       still differ); each group is `role="group"` named by its translated
 *       type label. ArrowDown and ArrowUp move `aria-activedescendant` and
 *       `aria-selected` over the options in DOM order while focus stays in
 *       the input; Enter opens the active hit. Whether "see all" links are
 *       options is the builder's choice.
 *   R7. Groups. In the served order (contact, lead, account, deal), hits in
 *       served order, never re-sorted, at most three drawn. No count, total,
 *       "more" or estimate anywhere (D-P13): a group's own copy holds no
 *       digit. An empty group is omitted or drawn empty, never with a count
 *       or a hint.
 *   R8. "See all" (R18 of the contract). For contacts, leads and accounts,
 *       `/contacts?q=…`, `/leads?q=…`, `/accounts?q=…` carrying exactly the
 *       `q` that was searched and nothing else; offered for every answered
 *       name query, an empty one included (a list's `q` is a substring and
 *       matches more); never for deals; never for a lookup (it would put the
 *       identifier in a URL). The three list screens read `q` from their URL
 *       as their first search, show it in their search box and send it on
 *       their list read. What they then do with their address bar is their
 *       own suites' business.
 *   R9. Requests. A name goes to searchRecords as `q` with `types` absent or
 *       all four. Never a control character (a tab is collapsed or removed),
 *       never over 100 characters (truncated or refused), never under 2 once
 *       folded the contract's way (NFD, marks removed, lower-cased, trimmed,
 *       inner whitespace collapsed), so `É`, `s` + a combining accent, ` s `
 *       and `Ø` send nothing and draw neither "no matches" nor an error.
 *       Debounced: a word typed fast is at most two requests.
 *   R10. Latest wins. A newer query is sent without waiting for an older one
 *       to answer, and only the answer to the current input is drawn: a stale
 *       answer or a stale failure changes nothing. Aborting a superseded
 *       request is allowed.
 *   R11. R21 routing on the client. The classifier is the contract's: after
 *       NFKC, an `@`, or 6 or more digits once whitespace and `+()-.` are
 *       removed. Such input goes ONLY to lookupRecords: a POST,
 *       `application/json`, no query string, the closed body with exactly
 *       one of `email` (it has an `@`) or `phone` (it does not), plus `types`
 *       absent, all four, or contact and lead. The value is the whole input
 *       (trimmed; the client may NFKC-normalise it), never a prefix of it.
 *       Input that is not identifier-shaped never goes to the lookup.
 *   R12. The URL never carries a phone number or an email address: not any
 *       request URL, the address bar, a history entry or its state, a link,
 *       or the title. The screen MAY keep a name `q` in its own URL; never an
 *       identifier. A crafted `/search?q=<identifier>` is never searched or
 *       looked up, never put in the box, and is removed from the address bar.
 *   R13. Partial identifiers. A partial number or address is refused, by the
 *       lookup's `400 invalid_phone` / `invalid_email` or by the screen
 *       before sending, and drawn as its own refusal
 *       (`data-testid="search-invalid"`, the translated label), never as a
 *       failure, never with hits, never as a prefix search. P27/A2's "0803
 *       456 also matches…" is overruled (contract R5) and its hint is absent.
 *   R14. Only served fields. `displayName` is drawn as served, never composed
 *       from its parts. When it is withheld (D-L68), a readable name part is
 *       drawn and nothing is guessed; with no readable name, the name is a
 *       lock (`data-locked="true"`, the lock icon, a translated neutral
 *       label), never the id. A lookup hit never draws the number or address
 *       that found it. Markup in a name is text. Whether companies or lead
 *       status are drawn is the builder's choice, translated if so.
 *   R15. Links only from well-formed uuids, URL-encoded: contacts and leads
 *       to `/contacts/<id>` (a lead's id is a contact id), accounts to
 *       `/accounts/<id>`. A deal hit is not a link: there is no deal screen
 *       yet (T-0110 adds the link and re-pins the spec). A malformed id is
 *       never linked and never printed; no UUID is printed anywhere.
 *   R16. States. Loading, no matches, failed and refused are four distinct
 *       states. Nothing typed is none of them and draws no hit (no recent
 *       searches); a too-short query is none of them.
 *   R17. A type the caller cannot read (deals for `client_portal`) is an
 *       empty group: no hint, lock, count or error (contract R9, D-L115).
 *   R18. Additive types (contract R17). A group whose `type` the screen does
 *       not know is ignored and the rest drawn; the client's parse never
 *       fails the whole answer for it.
 *   R19. The device. No storage API in the slice or the client; nothing the
 *       search typed or was served is written to device storage; no recent
 *       searches, not even in memory between openings (the palette reopens
 *       empty); none read from the API.
 *   R20. Absent (D-L133's overruled items and the frames not served): partial-
 *       number search, the hidden-results count, filters, facets and chip
 *       counts, sort, the scope menu and programme switching, recent
 *       searches, commands, calls and Ask AI, the "create contact or lead"
 *       offer on no results (no create screen takes a prefilled value without
 *       a URL), and the tickets, conversations and KB groups.
 *   R21. Scope is the session's (CLAUDE.md 2.2): no programme, owner or scope
 *       argument, header or parameter; same-origin relative paths; Zod.
 *   R22. i18n: group labels under ids containing `search` or `palette` ending
 *       `.group.<type>`; `.invalid_phone` and `.invalid_email` labels; every
 *       named id in every design-menu catalogue; `records.error.<code>` for
 *       both operations' codes; the lint rule fires on the route; no English
 *       in a user-facing attribute.
 *   R23. No colour literal in the slice; the slice is the `/search` route
 *       directory and the CRM shell (`components/crm`), and everything they
 *       import by a relative path, transitively, except the auth and admin
 *       shells. It must contain the P27 screen and the palette.
 *   R24. 360 px: no sideways page scroll, the header entry reachable,
 *       axe-clean with results.
 *   R25. en-XA renders every string of the screen and the palette as pseudo
 *       text, record data excepted; keyboard hints in `<kbd>` are exempt.
 *   R26. Budget. SEARCH_BUDGET_BYTES is a 250,000-byte PLACEHOLDER under a
 *       255,000-byte ceiling; the lead pins it within 5% of the builder's
 *       first green measurement (D-L118). Until then the budget test fails by
 *       design. The palette rides in the shell of every CRM screen, so its
 *       first-load weight lands in every other screen's pinned budget; those
 *       suites must still pass (loading it on first open is the obvious way).
 *
 * BUILDER'S CHOICES: the layout; the debounce interval; whether `/search`
 * keeps a name `q` in its URL; whether superseded requests are aborted;
 * whether a partial identifier is refused before sending; which readable name
 * parts a withheld-name hit draws, and whether companies and lead status are
 * drawn; how the palette loads (`next/dynamic` on first open is advised,
 * R26); where the search client lives (a `lib/` module); the copy.
 *
 * NOT HELD HERE, AND WHY
 *   - The `/` shortcut to the top-bar search (P27/A): harmless, not asked
 *     for. If built it must not fire inside a text field.
 *   - Opening a deal: no deal screen yet (T-0110).
 *   - The lead group's emptiness when `status` is withheld (contract R10):
 *     the server's rule, invisible to the client.
 *   - listContacts' and listLeads' own `q` still accept numbers in their URL
 *     (D-L133, open, T-0124). This screen never routes an identifier there.
 *
 * THE BROWSER HALF. `tests/e2e/p27-search.spec.ts` (journeys) and
 * `tests/e2e/support/search-mock.ts` (the contract mock, which checks every
 * request and every answer against the YAML) were written with this suite and
 * are PINNED by hash below, because `tests/e2e` is not path-protected
 * (D-L64). SEARCH_BUDGET_BYTES is the one line that may change without a
 * re-pin.
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p27-search --reporter=list,<ours>
 *
 * spawned with `shell: false` and the arguments as an array (D-L62). Every
 * test is read from the outcomes file our reporter writes, so a skipped,
 * `fixme`d or unmatched test never counts. No other spec's tag contains
 * `@p27-search`, and it contains no other screen's parent tag (section 5).
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const FLAG = 'crm_search';
/** The flags of the records process that `crm_search` rides on. */
const RECORDS_PROCESS_FLAGS = ['crm_records', 'crm_accounts', 'crm_record_view', 'crm_leads'];

const E2E_TAG = '@p27-search';

/** Every other screen's parent tag. None may contain ours, and ours may contain none (D-L84). */
const OTHER_PARENT_TAGS = [
  '@p01',
  '@p02',
  '@p02-live',
  '@p04',
  '@p04-accounts',
  '@p05-contact',
  '@p05-account',
  '@leads-p04',
  '@p06-pipeline',
  '@p07',
  '@p10-builder',
  '@p10-agent',
  '@harness',
];

/** `next build` (SWC wasm on the dev host, D-L62), a container, the servers and the journeys. */
const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p27-search.spec.ts';
const MOCK = 'tests/e2e/support/search-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/p27-search-budget.json';
const CONTRACT = 'docs/api/records.openapi.yaml';

/**
 * The pinned browser half (CRLF folded to LF; the budget literal normalised).
 * A change to either file is a change to the acceptance contract: the lead
 * re-pins it, the builder does not.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  [SPEC]: '30d6031fea1a3f8cd58d3473302fbb3b4a37b84ea58094aab4900a0220278acc',
  [MOCK]: 'cb0f1f8f22adc10cb8037082b49b2693737932492781563c42597cbcfa0a68e2',
};

/** Never above this (R26). */
const SEARCH_BUDGET_CEILING = 255_000;

/** Pinned within 5% of what the run measured, like /activities (D-L118) and /leads (T-0058). */
const BUDGET_HEADROOM = 1.05;

const PRD_CEILING_BYTES = 300 * 1024;

/** The operations the screen calls, for the error-localisation check. */
const OPERATIONS: readonly (readonly [path: string, method: string])[] = [
  ['/api/v1/search', 'get'],
  ['/api/v1/search/lookup', 'post'],
];

const GROUP_TYPES = ['contact', 'lead', 'account', 'deal'] as const;

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the mock's validators
  // reject malformed requests and answers, so every afterEach "no violations"
  // and "no mock faults" means something.
  ['@p27-search-mock', 'the contract mock refuses what the contract and the screen’s rules refuse, and checks its own answers'],
  // Passes before the work starts too (there is no route and no palette): a
  // negative invariant, given meaning by @p27-search-flag-on.
  ['@p27-search-flag-off', '/search is a 404 with crm_search at its default, Ctrl+K opens nothing, and the browser cannot flip it'],
  ['@p27-search-flag-on', '/search renders the P27 screen with crm_search on'],
  ['@p27-search-shell', 'the CRM shell’s header links /search, current there and on other screens; no link a 404'],
  ['@p27-search-palette', 'Ctrl+K and Cmd+K open a labelled modal dialog; focus trapped; Escape closes and returns focus; axe-clean'],
  ['@p27-search-keyboard', 'combobox, named listbox and groups; arrows move the active option; Enter opens it'],
  ['@p27-search-groups', 'groups in served order, at most three hits in served order, labelled, no count, total or "more"'],
  ['@p27-search-see-all', '"see all" to /contacts, /leads, /accounts with q, never deals, read by the list; offered when empty'],
  ['@p27-search-requests', 'debounced; never under 2 folded characters, over 100, or with a control character'],
  ['@p27-search-latest', 'a newer query is sent at once; a stale answer or failure never replaces it'],
  ['@p27-search-lookup-phone', 'a phone in any format, full-width included, only to lookupRecords as a POST body'],
  ['@p27-search-lookup-email', 'an email only to lookupRecords as a POST body, whole'],
  ['@p27-search-url', 'no phone or email in any URL, history entry, link or title; a crafted one is ignored and removed'],
  ['@p27-search-partial', 'a partial number or address refused as such, never a prefix search, no "also matches" hint'],
  ['@p27-search-fields', 'displayName as served, never composed; withheld parts never shown; a lock when nameless; markup as text'],
  ['@p27-search-links', 'links only from well-formed uuids, deals not linked, no id printed'],
  ['@p27-search-states', 'loading, no matches, failed and refused kept apart'],
  ['@p27-search-unreadable', 'an unreadable type is simply empty: no hint, lock, count or error'],
  ['@p27-search-additive', 'a group of an unknown type is ignored, the rest drawn'],
  ['@p27-search-device', 'nothing stored on the device; no recent search, even in memory between openings'],
  ['@p27-search-absent', 'no partial-number hint, hidden count, facets, filters, scope menu, recents, commands, AI or create'],
  ['@p27-search-mobile', '360 px: no sideways scroll, the header entry, axe-clean'],
  ['@p27-search-pseudo', 'en-XA renders pseudo text on the screen and the palette'],
  ['@p27-search-budget', '/search inside its byte budget on the production build'],
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

const SEARCH_ROUTE = /^apps\/web\/app\/(?:\([\w-]+\)\/)*search\/page\.tsx$/;
const SHELL = 'apps/web/components/crm/crm-shell.tsx';
const SHELL_DIRECTORY = 'apps/web/components/crm/';

function searchPage(): string | undefined {
  return trackedFiles('apps/web/app').find((file) => SEARCH_ROUTE.test(file));
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Shared shells other suites hold; not part of this slice. The CRM shell IS (it gains the palette). */
const OTHER_SHELLS = ['apps/web/components/auth/', 'apps/web/components/admin/'];

/**
 * The slice: every file in the `/search` route directory and the CRM shell,
 * and everything they import by a relative path, transitively, minus the
 * auth and admin shells.
 */
function sliceSources(): SourceFile[] {
  const page = searchPage();
  if (page === undefined) {
    return [];
  }
  const sources = new Map(webSources().map((entry) => [entry.file, entry.source]));
  const routeDirectory = posix.dirname(page);
  const queue = [...sources.keys()].filter((file) => file.startsWith(`${routeDirectory}/`) || file.startsWith(SHELL_DIRECTORY));
  const seen = new Set<string>();
  const resolveImport = (from: string, specifier: string): string | undefined => {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    return [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) => sources.has(candidate));
  };
  while (queue.length > 0) {
    const file = queue.shift() ?? '';
    if (seen.has(file) || OTHER_SHELLS.some((shell) => file.startsWith(shell))) {
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

/** The slice, refused unless the route exists and it contains the P27 screen and the palette. */
function screenSlice(): SourceFile[] {
  expect(searchPage(), 'there is no apps/web/app/**/search/page.tsx').toBeDefined();
  const slice = sliceSources();
  expect(
    slice.filter(({ source }) => /['"`]P27['"`]/.test(withoutComments(source))).map(({ file }) => file),
    'the /search route imports no P27 screen (data-screen="P27")',
  ).not.toEqual([]);
  expect(
    slice.filter(({ source }) => /['"`]command-palette['"`]/.test(withoutComments(source))).map(({ file }) => file),
    'nothing the CRM shell or /search imports is the palette (data-testid="command-palette")',
  ).not.toEqual([]);
  return slice;
}

/** apps/web/lib modules that call the search API. */
function searchClients(): SourceFile[] {
  return webSources().filter(({ file, source }) => file.startsWith('apps/web/lib/') && /\/api\/v1\/search\b/.test(withoutComments(source)));
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8')) as Record<string, string>;
}

const BUDGET_LITERAL = /const SEARCH_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(BUDGET_LITERAL, 'const SEARCH_BUDGET_BYTES = <budget>;');
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
 * rule sees only a string that IS a hex value). The design's group-icon tints
 * are `var(--k-*-soft)` tokens; a `color-mix(...)` in apps/web is a literal.
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
 * An identifier put into a query string by hand: a `phone` or `email` query
 * parameter, or one set on URLSearchParams. A heuristic (R11, R12): the e2e
 * URL journey is the real check.
 */
function identifierInQuery(source: string): string[] {
  const code = withoutComments(source);
  return [
    ...(code.match(/[?&](?:phone|email)=/g) ?? []),
    ...(code.match(/\.(?:set|append)\(\s*['"`](?:phone|email)['"`]/g) ?? []),
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

/** The body of an exported async function in lib/feature-flags.ts. */
function flagFunctionBody(name: string): string {
  const flagModule = withoutComments(readFileSync(fromRoot('apps/web/lib/feature-flags.ts'), 'utf8'));
  const match = new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(flagModule);
  return match?.[1] ?? '';
}

/** The test tags in a spec's code (titles and annotations), comments and package scopes excluded. */
function tagsIn(file: string): string[] {
  return [...withoutComments(readFileSync(fromRoot(file), 'utf8')).matchAll(/@[a-z0-9][\w-]*/gi)]
    .map((match) => match[0])
    .filter((tag) => /^@(p\d|leads|harness)/i.test(tag));
}

/** en.json ids about search or the palette ending with one of `suffixes`. */
function searchKey(en: Record<string, string>, suffixes: readonly string[]): string | undefined {
  return Object.keys(en).find((id) => /search|palette/i.test(id) && suffixes.some((suffix) => id.endsWith(suffix)));
}

// ===========================================================================
// 1. The flag, the route, the shell, the harness and the client
// ===========================================================================

describe('acceptance: T-0087 — crm_search exists, is off, is not production-ready, and gates /search and the palette', () => {
  it('registers crm_search, not production-ready, and it evaluates OFF by default', async () => {
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

  it('has a /search route file that calls notFound() on crm_search, read on the server only', () => {
    const page = searchPage();
    expect(page, 'there is no apps/web/app/**/search/page.tsx').toBeDefined();
    const source = withoutComments(readFileSync(fromRoot(page ?? 'missing'), 'utf8'));
    expect(source, `${page} does not call notFound()`).toMatch(/\bnotFound\s*\(/);
    expect(source, `${page} imports nothing from lib/feature-flags`).toMatch(/from ['"][./]*lib\/feature-flags['"]/);
    // A dedicated reader, or a generic one called with the name. crmLiveNav
    // names the flag too, but it is not a gate.
    const readers = readersOf(FLAG).filter((name) => name !== 'crmLiveNav');
    const gated = readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source)) || new RegExp(`['"]${FLAG}['"]`).test(source);
    expect(gated, `${page} is not gated on ${FLAG} (readers found: ${readers.join(', ') || 'none'})`).toBe(true);
    const clientEvaluators = webSources().filter(({ source: code }) => /^\s*['"]use client['"]/m.test(code) && code.includes(FLAG));
    expect(clientEvaluators.map(({ file }) => file), 'a client module names crm_search — flags are read on the server only').toEqual([]);
  });

  it('lists search in crmLiveNav() only through crm_search, and the shell draws its entry and palette only then (R2)', () => {
    const live = flagFunctionBody('crmLiveNav');
    expect(live, 'crmLiveNav() is gone from lib/feature-flags.ts').not.toBe('');
    expect(live, 'crmLiveNav() never lists search').toMatch(/['"]search['"]/);
    const readers = readersOf(FLAG).filter((name) => name !== 'crmLiveNav');
    expect(
      readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(live)) || new RegExp(`['"]${FLAG}['"]`).test(live),
      'crmLiveNav() does not read crm_search: the palette would mount with the flag off',
    ).toBe(true);
    const shell = withoutComments(readFileSync(fromRoot(SHELL), 'utf8'));
    expect(shell, 'the CRM shell does not decide by live.includes("search")').toMatch(/\blive\.includes\(\s*['"]search['"]\s*\)/);
    expect(shell, 'the CRM shell does not link /search').toMatch(/['"`]\/search['"`]/);
  });

  it('serves the journeys from the records process with crm_search on, publishes webSearchUrl, and leaves the default server flagless (R3)', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    const processes = [...runner.matchAll(/KASUWA_FEATURE_FLAGS_ON:\s*['"`]([^'"`]*)['"`]/g)].map((match) => (match[1] ?? '').split(/[,\s]+/));
    expect(
      processes.some((flags) => flags.includes(FLAG) && RECORDS_PROCESS_FLAGS.every((flag) => flags.includes(flag))),
      `no web process in run-e2e.mjs carries ${FLAG} beside ${RECORDS_PROCESS_FLAGS.join(', ')}`,
    ).toBe(true);
    expect(runner, 'run-e2e.mjs does not publish webSearchUrl in the stack file').toContain('webSearchUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*''/);
  });

  it('calls both search operations same-origin, Zod-parsed, the lookup as a POST, with no scope argument and no identifier in a query string', () => {
    const clients = searchClients();
    expect(clients.map(({ file }) => file), 'no apps/web/lib module calls /api/v1/search').not.toEqual([]);
    expect(
      clients.some(({ source }) => /['"`/]lookup['"`]|\/api\/v1\/search\/lookup/.test(withoutComments(source))),
      'no apps/web/lib module calls the lookup (/api/v1/search/lookup)',
    ).toBe(true);
    expect(
      clients.some(({ source }) => /method:\s*['"`]POST['"`]/.test(withoutComments(source))),
      'the search client never sends a POST: the lookup must carry its identifier in a body',
    ).toBe(true);
    for (const { file, source } of clients) {
      const code = withoutComments(source);
      expect(code, `${file} names an absolute API origin`).not.toMatch(/https?:\/\/[^'"`]*\/api\/v1/);
      expect(code, `${file} does not parse with Zod`).toMatch(/from ['"]zod['"]/);
      expect(code, `${file} builds a scope argument`).not.toMatch(
        /programmeIds?|ownerUserIds|(set|append)\(\s*['"`](programme|owner|scope)|['"`]x-[\w-]*(programme|tenant|scope)/i,
      );
      expect(identifierInQuery(source), `${file} puts a phone or an email in a query string (R21)`).toEqual([]);
    }
    for (const { file: name, source } of webSources()) {
      expect(withoutComments(source), `${name} imports test support`).not.toMatch(
        /from ['"][^'"]*(tests\/e2e|search-mock|records-mock|@kasuwa\/testing)[^'"]*['"]/,
      );
    }
  });

  it('keeps no identifier in a query string anywhere in the slice either (R12)', () => {
    const found = screenSlice().flatMap(({ file, source }) => identifierInQuery(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'the slice writes a phone or an email into a query string').toEqual([]);
  });
});

// ===========================================================================
// 2. i18n — the lint rule, every catalogue, D-P1
// ===========================================================================

describe('acceptance: T-0087 — every string through i18n, in every catalogue, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the /search route file', () => {
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(
      /files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/,
    );
    // A rule only ever seen passing proves nothing: plant a literal at the route's own path.
    const page = searchPage();
    expect(page, 'there is no apps/web/app/**/search/page.tsx').toBeDefined();
    const planted = eslint(
      ['--stdin', '--stdin-filename', page ?? 'apps/web/app/search/page.tsx', '--format', 'json'],
      'export default function Planted() {\n  return <p>No matches found</p>;\n}\n',
    );
    expect(planted.output, `a literal JSX string at ${page} is not rejected:\n${planted.output.slice(-2000)}`).toContain('i18next/no-literal-string');
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const slice = screenSlice();
    const run = eslint(['--max-warnings', '0', ...slice.map(({ file }) => file)]);
    expect(run.status, `eslint fails on the search slice:\n${run.output.slice(-4000)}`).toBe(0);
    // jsx-text-only cannot see attributes; an English aria-label is still English.
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('puts every message the slice names, a label for each group type, invalid_phone and invalid_email, in every design-menu catalogue', async () => {
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
    // The CRM shell alone names about a dozen; the search must add its own.
    expect(
      [...named].filter((id) => /search|palette/i.test(id)).length,
      'the search slice names almost no search message id',
    ).toBeGreaterThan(8);

    const find = (what: string, key: string | undefined): string => {
      expect(key, `en.json has no label for ${what}`).toBeDefined();
      return key ?? `<missing ${what}>`;
    };
    expect(enumAt('SearchType', 'enum'), 'the contract’s search types changed').toEqual([...GROUP_TYPES]);
    const groupKeys = GROUP_TYPES.map((type) =>
      find(`the ${type} group (an id about search ending ".group.${type}")`, searchKey(en, [`.group.${type}`])),
    );
    const phoneKey = find('invalid_phone (an id about search ending ".invalid_phone" or ".invalidPhone")', searchKey(en, ['.invalid_phone', '.invalidPhone']));
    const emailKey = find('invalid_email (an id about search ending ".invalid_email" or ".invalidEmail")', searchKey(en, ['.invalid_email', '.invalidEmail']));

    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const key of [...named, ...groupKeys, phoneKey, emailKey]) {
        if (typeof messages[key] !== 'string' || messages[key].trim() === '') {
          missing.push(`${locale}: ${key}`);
        }
      }
    }
    expect(missing, 'message ids the search uses that a catalogue lacks').toEqual([]);
  });

  it('localises every error the two search operations can answer with', () => {
    // NOTE: passes before the work starts — searchRecords and lookupRecords
    // answer validation_failed and not_authenticated, both localised since
    // T-0042. It is here so a new code in the contract (or a dropped key)
    // fails this suite rather than reaching a user as a raw code.
    const en = catalogue('en');
    const codes = new Set(OPERATIONS.flatMap(([path, method]) => errorCodes(path, method)));
    expect([...codes], 'the search operations declare no error codes').toEqual(expect.arrayContaining(['validation_failed', 'not_authenticated']));
    const missing = [...codes].filter((code) => en[`records.error.${code}`] === undefined);
    expect(missing, 'en.json lacks records.error.<code> for these errors').toEqual([]);
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
// 3. Colour, identifiers in URLs, and the device
// ===========================================================================

describe('acceptance: T-0087 — no colour literal and no device storage in the slice', () => {
  it('the colour and identifier detectors catch what the lint rule misses', () => {
    // Planted first: a detector only ever seen finding nothing proves nothing.
    // Passes before the work starts, by design.
    for (const planted of [
      'className="text-[#c00] p-2"',
      "style={{ color: 'red' }}",
      'className="bg-sky-100"',
      "const tint = 'color-mix(in oklch, var(--k-info) 18%, var(--k-surface))';",
      'className="border-white"',
    ]) {
      expect(colourLiterals(planted), `the colour detector missed ${planted}`).not.toEqual([]);
    }
    expect(colourLiterals('className="bg-surface text-text-2 border-border-strong bg-primary-soft text-info-text"')).toEqual([]);
    for (const planted of [
      'fetch(`/api/v1/search?phone=${value}`)',
      "params.set('email', value);",
      'url.searchParams.append("phone", typed);',
      "router.push('/contacts?email=' + typed);",
    ]) {
      expect(identifierInQuery(planted), `the identifier detector missed ${planted}`).not.toEqual([]);
    }
    expect(identifierInQuery("params.set('q', name); fetch('/api/v1/search/lookup', { method: 'POST', body: JSON.stringify({ phone }) });")).toEqual([]);
  });

  it('the slice reaches the screen and the palette through its imports, and stops at the auth and admin shells', () => {
    const slice = screenSlice();
    const files = slice.map(({ file }) => file);
    expect(files).toContain(searchPage() ?? '<no page>');
    expect(files).toContain(SHELL);
    expect(files.filter((file) => OTHER_SHELLS.some((shell) => file.startsWith(shell)))).toEqual([]);
    expect(files.length, 'the slice is the route and the shell alone: nothing they import was followed').toBeGreaterThan(3);
  });

  it('writes no colour literal anywhere in the slice', () => {
    const found = screenSlice().flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the search slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('touches no device-storage API (R19, D-P21)', () => {
    const storage = /\b(localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|navigator\.storage|document\.cookie)\b/;
    const found = [...screenSlice(), ...searchClients()].filter(({ source }) => storage.test(withoutComments(source))).map(({ file }) => file);
    expect(found, 'the search slice uses a device-storage API: no recent search is kept anywhere').toEqual([]);
  });
});

// ===========================================================================
// 4. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0087 — the journeys and the mock are the ones this suite was written with', () => {
  it('pins p27-search.spec.ts and search-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(
        normalisedHash(file),
        `${file} changed. It is part of the T-0087 acceptance contract: ask the lead to re-pin it ` +
          '(only SEARCH_BUDGET_BYTES may move without that).',
      ).toBe(pinned);
    }
    const mock = readFileSync(fromRoot(MOCK), 'utf8');
    expect(mock, 'the mock no longer reads the records contract').toContain(CONTRACT);
    expect(mock, 'the mock no longer checks its own answers against the contract').toMatch(/answerProblems\(operation, status, body\)/);
    expect(mock, 'the mock no longer reads R21’s pattern from the contract').toContain('Q_PARAMETER.schema.not.pattern');
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    expect(BUDGET_LITERAL.test(spec), 'SEARCH_BUDGET_BYTES is not where it was').toBe(true);
    expect(spec, 'the journeys no longer tap history for identifiers').toContain('__kasuwaHistory');
  });
});

// ===========================================================================
// 5. The tag is this screen's alone (D-L84)
// ===========================================================================

describe('acceptance: T-0087 — @p27-search selects these journeys and nothing else', () => {
  it('no other spec carries a tag @p27-search matches, ours matches no other parent tag, and the spec carries only ours', () => {
    // Passes before the work starts: it guards later screens against
    // colliding with this one, as `@p04` once collided with `@p04-accounts`.
    const specs = trackedFiles('tests/e2e').filter((file) => file.endsWith('.spec.ts') && existsSync(fromRoot(file)));
    expect(specs).toContain(SPEC);
    const ours = tagsIn(SPEC);
    expect(ours.length).toBeGreaterThan(REQUIRED.length);
    expect(ours.filter((tag) => tag !== E2E_TAG && !tag.startsWith(`${E2E_TAG}-`)), 'the spec carries another screen’s tag').toEqual([]);
    for (const [tag] of REQUIRED) {
      expect(ours, `no journey carries ${tag}`).toContain(tag);
    }
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
// 6. The browser — one run of @p27-search
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0087 e2e run did not start', outcomes: undefined, startedAt: 0 };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

function outcomes(): E2eOutcome[] {
  expect(e2eRun.outcomes, `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-6000)}`).toBeDefined();
  return e2eRun.outcomes ?? [];
}

describe('acceptance: T-0087 — the search and the palette in a browser', () => {
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

  it('runs every @p27-search journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(journeys.length, 'the run reported fewer @p27-search tests than there are behaviours').toBeGreaterThanOrEqual(REQUIRED.length);
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p27-search tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter((outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag));
      expect(proving.length, `no PASSING @p27-search test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('pins /search at or under 255,000 bytes and within 5% of what this run measured (R26)', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'SEARCH_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /search budget is above its ceiling').toBeLessThanOrEqual(SEARCH_BUDGET_CEILING);
    expect(budget).toBeLessThan(PRD_CEILING_BYTES);

    const record = fromRoot(BUDGET_RECORD);
    expect(existsSync(record), 'the budget test wrote no measurement').toBe(true);
    expect(statSync(record).mtimeMs, 'the measurement is older than this run').toBeGreaterThanOrEqual(e2eRun.startedAt);
    const measured = (JSON.parse(readFileSync(record, 'utf8')) as { transferredBytes: number }).transferredBytes;
    expect(measured, 'the measurement is empty').toBeGreaterThan(0);
    expect(budget, `the budget is under the ${measured} bytes measured`).toBeGreaterThanOrEqual(measured);
    expect(budget, `the budget is more than 5% over the ${measured} bytes measured — the lead pins SEARCH_BUDGET_BYTES`).toBeLessThanOrEqual(
      Math.round(measured * BUDGET_HEADROOM),
    );
  });
});
