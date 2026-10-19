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
 * ACCEPTANCE — T-0063, the P05 account record, frame 04 (Agent 11, Frontend &
 * Design System). Decisions: D-L63, D-L64, D-L69, D-L74, D-L78, D-L84, D-L85,
 * D-L90, D-P13, D-P18, D-P21.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. The route `apps/web/app/(group)/accounts/[id]/page.tsx` calls
 *      `notFound()` and is gated on BOTH `crm_record_view` (the P05 record
 *      flag, T-0062) and `crm_accounts` (T-0057), read on the server through
 *      `lib/feature-flags.ts`; no client module names either. Both flags stay
 *      registered, default off and not production-ready. The e2e process that
 *      serves the journeys carries both.
 *   2. The browser reads the account, its ancestors, its contacts and its
 *      timeline, and writes the account and its activities, same-origin and
 *      Zod-parsed, with no scope argument. No apps/web module imports test
 *      support.
 *   3. P05/04 against the contract mock, by e2e tag (section 6): details by
 *      account field security (locks, never an input for a withheld field);
 *      the hierarchy breadcrumb by walking `parentAccountId`, at most four
 *      ancestors (D-L74); the contacts grid from listAccountContacts, keyset
 *      paged, with the 400 `field_withheld` message distinct from "no
 *      contacts"; the account timeline (field changes by name only, actors by
 *      name, keyset "load older"); completing a task with the `version` its
 *      timeline item carries (T-0080), a 409 re-read and never retried blind;
 *      logging a note, task or call with `accountId` and no contact; the edit
 *      (version plus only what changed); refusals as translated alerts; the
 *      generic not-found, and a real 404 that reads nothing for a non-uuid id;
 *      loading; offline in memory only (D-L64, D-P21); hidden features (D-L69:
 *      rollups, Health, Map); no UUID printed; no account name in the title
 *      (D-L63); 360 px; en-XA; the byte budget.
 *   4. i18n: the literal-string rule fires on the route; every message id the
 *      slice names is in every design-menu catalogue; a label for every
 *      account timeline field, every tier and every activity type; a
 *      `records.error.<code>` for every code the operations answer; no
 *      language falls off the menu.
 *   5. No colour literal (wider than the lint rule, D-L84) and no
 *      device-storage API in the slice.
 *
 * PINNED INTERFACES (the builder's side): the DOM hooks and interfaces listed
 * in the header of `tests/e2e/p05-account.spec.ts`; the route file above;
 * account field labels under an id ending `.field.<name>` or `.col.<name>`;
 * tier labels under an id ending `.tier.<code>`; activity-type labels under an
 * id containing `activit` and ending `.type.<code>`.
 *
 * BUILDER'S CHOICES: the layout (three columns, tabs on mobile, as frame 04
 * shows, or simpler); whether the grid draws more Contact columns than name
 * and phone (any it draws follow field security); whether contact rows and
 * ancestors link (they may not link to a 404); whether the programme is shown
 * (by name if it is); whether the edit re-parents (if it does, by name, never
 * a uuid input); where the record client lives; whether the contact record's
 * account summary now links here (T-0062 allows it once this resolves); the
 * copy.
 *
 * THE SLICE. Every apps/web module the `/accounts/[id]` route directory
 * imports, transitively by relative import, except the shared shells
 * (`components/auth`, `components/crm`, `components/admin`). It must contain
 * the P05 account screen (a module naming `P05/04`), so the P04 list's own
 * modules do not count.
 *
 * NOT HELD HERE, AND WHY
 *   - The hierarchy's CHILDREN. Nothing serves them: `Account` carries the one
 *     `parentAccountId` link and listAccounts has no parent filter. The spec
 *     carries `@p05-account-children` as a `fixme` and REQUIRED omits it. A
 *     contract gap for the lead (the T-0063 suite report).
 *   - "Non-writers see no write controls": D-L84's capability-read gap
 *     (T-0079). `@p05-account-writers` is a `fixme`; the refusals are held.
 *   - "The timeline gathers activity from every contact" (the frame's
 *     caption): listAccountTimeline carries the account's own activities only
 *     (T-0080); rollups are the pipeline slice's.
 *
 * THE BROWSER HALF. `tests/e2e/p05-account.spec.ts` (journeys) and
 * `tests/e2e/support/account-record-mock.ts` (the contract mock, which checks
 * every answer it gives against the YAML) were written with this suite and
 * are PINNED by hash below, because `tests/e2e` is not path-protected (D-L64).
 * ACCOUNT_RECORD_BUDGET_BYTES is the one line that may change without a
 * re-pin, and only downwards towards the measurement (section 6).
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p05-account --reporter=list,<ours>
 *
 * spawned with `shell: false` and the arguments as an array (D-L62). Every
 * test is read from the outcomes file our reporter writes, so a skipped,
 * `fixme`d or unmatched test never counts. No other spec's tag contains
 * `@p05-account`, and it contains no other screen's parent tag (section 5,
 * D-L84).
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const RECORD_FLAG = 'crm_record_view';
const ACCOUNTS_FLAG = 'crm_accounts';

const E2E_TAG = '@p05-account';

/** Every other screen's parent tag. None may contain ours, and ours may contain none (D-L84). */
const OTHER_PARENT_TAGS = ['@p01', '@p02', '@p04', '@p04-accounts', '@p05-contact', '@leads-p04'];

/** `next build` (SWC wasm on the dev host, D-L62), a container, the servers and the journeys. */
const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p05-account.spec.ts';
const MOCK = 'tests/e2e/support/account-record-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/p05-account-budget.json';
const CONTRACT = 'docs/api/records.openapi.yaml';

/**
 * The pinned browser half (CRLF folded to LF; the budget literal normalised).
 * A change to either file is a change to the acceptance contract: the lead
 * re-pins it, the builder does not.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  [SPEC]: '6ec161967da8cb5c8e9b4758a5f005287ab2de730872ba2104fa6aafe170870c',
  // T-0082 (D-L97): the mock's activity items and bodies carry `startsAt` and `endsAt`.
  // T-0091 (lead re-pin): the mock answers listCustomFields (empty unless a journey sets custom fields) and merges `custom`.
  // T-0124 (lead re-pin, D-L183): listAccountContacts' default sort is read from the contract (-createdAt), not invented as displayName.
  [MOCK]: '219df4b7dcf75cc08a3c44b7362788791c3684053583e4d0aca6192fcc0d2ace',
};

/** See the budget test in the spec. Never above this. */
const ACCOUNT_RECORD_BUDGET_CEILING = 245_000;

/** Re-pinned within 5% of what the run measured, like /contacts/[id] (T-0062) and P01/1 (T-0035). */
const BUDGET_HEADROOM = 1.05;

const PRD_CEILING_BYTES = 300 * 1024;

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the mock's validators
  // reject malformed requests and answers, so every afterEach "no violations"
  // and "no mock faults" means something.
  ['@p05-account-mock', 'the contract mock refuses what the contract refuses and checks its own answers'],
  // Passes before the work starts too (there is no route at all): a negative
  // invariant, given meaning by @p05-account-flag-on.
  ['@p05-account-flag-off', '/accounts/[id] is a 404 with every flag at its default, and the browser cannot flip it'],
  ['@p05-account-flag-on', '/accounts/[id] renders the record with crm_record_view and crm_accounts on'],
  ['@p05-account-shell', 'the CRM shell, no link on the page a 404, none to the Map'],
  ['@p05-account-details', 'fields as values and labels, never codes or ids; markup as text; no name in the title; axe-clean'],
  ['@p05-account-locked', 'a withheld field is a lock, never blank, never an input; a null is never a lock'],
  ['@p05-account-hierarchy', 'the breadcrumb root first by name, at most four ancestor reads, a lock for a withheld parent'],
  ['@p05-account-contacts', 'the served contacts in served order, keyset "more", locks per row, no count'],
  ['@p05-account-contacts-withheld', 'field_withheld is its own message, never "no contacts"; empty and failed are distinct'],
  ['@p05-account-timeline', 'every item once in served order; field changes by name only; actors by name, "System" for null'],
  ['@p05-account-paging', 'keyset "load older", the cursor echoed and never in the URL, no total'],
  ['@p05-account-complete', 'a task seen only on the timeline is completed with the version its item carries'],
  ['@p05-account-stale', 'a stale complete is a 409 alert; the screen re-reads, never retries blind'],
  ['@p05-account-log', 'a note, a task and a call logged once against the account, no contact, due times in UTC'],
  ['@p05-account-activity-refusals', 'a refused activity is a translated alert, the form kept, nothing added'],
  ['@p05-account-edit', 'the edit sends version and only what changed, and no withheld field'],
  ['@p05-account-refusals', '403 and 409 on the edit are translated alerts; the sheet, typing and served values are kept'],
  ['@p05-account-not-found', 'out of scope and missing are the generic not-found; a non-uuid id is a real 404 that reads nothing'],
  ['@p05-account-loading', 'skeleton; a failed read is not "not found"; a failed timeline is not "no history"'],
  ['@p05-account-offline', 'offline: memory only, last synced, every write disabled'],
  ['@p05-account-hidden', 'no rollups, money, Health, Map, related records, buying roles, counts or access request'],
  ['@p05-account-mobile', '360 px: no sideways scroll, axe-clean'],
  ['@p05-account-pseudo', 'en-XA renders pseudo text on the record'],
  ['@p05-account-budget', '/accounts/[id] inside its byte budget on the production build'],
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

/** The App Router page for `/accounts/[id]` (a route group such as `(crm)` allowed). */
function recordPage(): string | undefined {
  return trackedFiles('apps/web/app').find((file) =>
    /^apps\/web\/app\/(?:\([\w-]+\)\/)*accounts\/\[id\]\/page\.tsx$/.test(file),
  );
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
  const page = recordPage();
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

/** The slice, refused unless it contains the P05 account screen itself. */
function screenSlice(): SourceFile[] {
  const slice = sliceSources();
  expect(recordPage(), 'there is no apps/web/app/**/accounts/[id]/page.tsx').toBeDefined();
  expect(
    slice.filter(({ source }) => withoutComments(source).includes('P05/04')).map(({ file }) => file),
    'the /accounts/[id] route imports no P05/04 screen (data-screen="P05/04")',
  ).not.toEqual([]);
  return slice;
}

/** apps/web/lib modules that talk to the records API about accounts, timelines or activities. */
function recordClients(): SourceFile[] {
  return webSources().filter(
    ({ file, source }) =>
      file.startsWith('apps/web/lib/') &&
      /\/timeline\b|\/api\/v1\/activities|\/api\/v1\/accounts/.test(withoutComments(source)),
  );
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8'),
  ) as Record<string, string>;
}

const BUDGET_LITERAL = /const ACCOUNT_RECORD_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(BUDGET_LITERAL, 'const ACCOUNT_RECORD_BUDGET_BYTES = <budget>;');
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
 * rule sees only a string that IS a hex value).
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

/** The tags in a spec's code (titles and annotations), comments excluded. */
function tagsIn(file: string): string[] {
  return [...withoutComments(readFileSync(fromRoot(file), 'utf8')).matchAll(/@[a-z0-9][\w-]*/gi)].map((match) => match[0]);
}

// ===========================================================================
// 1. The flags and the route
// ===========================================================================

describe('acceptance: T-0063 — /accounts/[id] is gated on crm_record_view AND crm_accounts', () => {
  it('keeps both flags registered, not production-ready, and OFF by default', async () => {
    // NOTE: passes before the work starts (T-0057 and T-0062 registered both).
    // It is here so the account record cannot ship by making either one
    // production-ready or default-on.
    await initialiseFeatureFlags();
    for (const flag of [RECORD_FLAG, ACCOUNTS_FLAG]) {
      expect(Object.keys(FLAGS), `${flag} is not declared in FLAGS`).toContain(flag);
      const definition = (FLAGS as Readonly<Record<string, { productionReady?: boolean; defaultValue?: boolean }>>)[flag];
      expect(definition?.defaultValue, `${flag} does not default off`).toBe(false);
      expect(definition?.productionReady, `${flag} is marked production-ready`).toBe(false);
      // `true` as the fallback on purpose: only a registered, default-off flag answers false.
      const value = await featureFlagClient().getBooleanValue(flag, true, toEvaluationContext({ tenantId: 'acceptance-probe' }));
      expect(value, `${flag} does not evaluate OFF by default`).toBe(false);
    }
  });

  it('has a route file that calls notFound() and is gated on both flags, read on the server only', () => {
    const page = recordPage();
    expect(page, 'there is no apps/web/app/**/accounts/[id]/page.tsx').toBeDefined();
    const source = withoutComments(readFileSync(fromRoot(page ?? 'missing'), 'utf8'));
    expect(source, `${page} does not call notFound()`).toMatch(/\bnotFound\s*\(/);
    expect(source, `${page} imports nothing from lib/feature-flags`).toMatch(/from ['"][./]*lib\/feature-flags['"]/);
    for (const flag of [RECORD_FLAG, ACCOUNTS_FLAG]) {
      const readers = readersOf(flag);
      // A dedicated reader, or a generic one called with the name. crmLiveNav
      // (the shell's nav) names crm_accounts too, but is not a gate.
      const gated =
        readers.filter((name) => name !== 'crmLiveNav').some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source)) ||
        new RegExp(`['"]${flag}['"]`).test(source);
      expect(gated, `${page} is not gated on ${flag} (readers found: ${readers.join(', ') || 'none'})`).toBe(true);
    }
    const clientEvaluators = webSources().filter(
      ({ source: code }) => /^\s*['"]use client['"]/m.test(code) && (code.includes(RECORD_FLAG) || code.includes(ACCOUNTS_FLAG)),
    );
    expect(clientEvaluators.map(({ file }) => file), 'a client module names a flag — flags are read on the server only').toEqual([]);
  });

  it('serves the journeys from a process carrying both flags, and leaves the default server flagless', () => {
    // NOTE: passes before the work starts (T-0062's process carries both). It
    // guards the harness against losing either flag from the journeys' process.
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    const processes = [...runner.matchAll(/KASUWA_FEATURE_FLAGS_ON:\s*['"`]([^'"`]*)['"`]/g)].map((match) => (match[1] ?? '').split(/[,\s]+/));
    expect(
      processes.some((flags) => flags.includes(RECORD_FLAG) && flags.includes(ACCOUNTS_FLAG)),
      'no web process in run-e2e.mjs carries both crm_record_view and crm_accounts',
    ).toBe(true);
    expect(runner, 'run-e2e.mjs does not publish webRecordViewUrl').toContain('webRecordViewUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*''/);
  });

  it('talks to the records API same-origin, Zod-parsed, with no scope argument, and imports no test support', () => {
    const clients = recordClients();
    // Vacuity guard: the contact record and accounts clients are already here.
    expect(clients.length, 'no apps/web/lib module talks to the records API').toBeGreaterThan(1);
    for (const { file, source } of clients) {
      const code = withoutComments(source);
      expect(code, `${file} names an absolute API origin`).not.toMatch(/https?:\/\/[^'"`]*\/api\/v1/);
      expect(code, `${file} does not parse with Zod`).toMatch(/from ['"]zod['"]/);
      // A programme in a query string, a header or a list of them is scope from the client.
      expect(code, `${file} builds a scope argument`).not.toMatch(
        /programmeIds|(set|append)\(\s*['"`]programme|['"`]x-[\w-]*(programme|tenant)/i,
      );
    }
    for (const { file: name, source } of webSources()) {
      expect(withoutComments(source), `${name} imports test support`).not.toMatch(
        /from ['"][^'"]*(tests\/e2e|account-record-mock|contact-record-mock|accounts-mock|records-mock|@kasuwa\/testing)[^'"]*['"]/,
      );
    }
  });
});

// ===========================================================================
// 2. i18n — the lint rule, every catalogue, D-P1
// ===========================================================================

describe('acceptance: T-0063 — every string through i18n, in every catalogue, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the /accounts/[id] route file', () => {
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(
      /files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/,
    );
    // A rule only ever seen passing proves nothing: plant a literal at the route's own path.
    const page = recordPage();
    expect(page, 'there is no apps/web/app/**/accounts/[id]/page.tsx').toBeDefined();
    const planted = eslint(
      ['--stdin', '--stdin-filename', page ?? 'apps/web/app/accounts/[id]/page.tsx', '--format', 'json'],
      'export default function Planted() {\n  return <p>More contacts</p>;\n}\n',
    );
    expect(planted.output, `a literal JSX string at ${page} is not rejected:\n${planted.output.slice(-2000)}`).toContain(
      'i18next/no-literal-string',
    );
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const slice = screenSlice();
    const run = eslint(['--max-warnings', '0', ...slice.map(({ file }) => file)]);
    expect(run.status, `eslint fails on the account record slice:\n${run.output.slice(-4000)}`).toBe(0);
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('puts every message the slice names, and a label for each timeline field, tier and activity type, in every design-menu catalogue', async () => {
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
    // Vacuity guard: a slice that names no catalogue key is not using i18n.
    expect(named.size, 'the account record slice names almost no message id').toBeGreaterThan(10);

    const find = (what: string, matches: (id: string) => boolean): string => {
      const key = Object.keys(en).find(matches);
      expect(key, `en.json has no label for ${what}`).toBeDefined();
      return key ?? `<missing ${what}>`;
    };
    const fields = enumAt('AccountFieldChangedItem', 'properties', 'field', 'enum');
    expect(fields, 'the contract lists no account timeline fields').toEqual(expect.arrayContaining(['name', 'tier', 'parentAccountId']));
    const fieldKeys = fields.map((name) =>
      find(`the account field ${name} (an id ending ".field.${name}" or ".col.${name}")`, (id) => id.endsWith(`.field.${name}`) || id.endsWith(`.col.${name}`)),
    );
    const tiers = enumAt('AccountTier', 'enum');
    expect(tiers.length, 'the contract lists no tiers').toBeGreaterThan(1);
    const tierKeys = tiers.map((code) => find(`the ${code} tier (an id ending ".tier.${code}")`, (id) => id.endsWith(`.tier.${code}`)));
    const types = enumAt('ActivityType', 'enum');
    expect(types).toEqual(expect.arrayContaining(['note', 'task', 'call']));
    const typeKeys = types.map((type) =>
      find(`the ${type} activity type (an id containing "activit", ending ".type.${type}")`, (id) => /activit/i.test(id) && id.endsWith(`.type.${type}`)),
    );

    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const key of [...named, ...fieldKeys, ...tierKeys, ...typeKeys]) {
        if (typeof messages[key] !== 'string' || messages[key].trim() === '') {
          missing.push(`${locale}: ${key}`);
        }
      }
    }
    expect(missing, 'message ids the account record uses that a catalogue lacks').toEqual([]);
  });

  it('localises every error the account record operations can answer with', () => {
    // NOTE: passes before the work starts — T-0042 added records.error.* for
    // every shared code. It is here so a new code in the contract (or a
    // dropped key) fails this suite rather than reaching a user as a raw code.
    const en = catalogue('en');
    const codes = new Set([
      ...errorCodes('/api/v1/accounts/{accountId}', 'get'),
      ...errorCodes('/api/v1/accounts/{accountId}', 'patch'),
      ...errorCodes('/api/v1/accounts/{accountId}/contacts', 'get'),
      ...errorCodes('/api/v1/accounts/{accountId}/timeline', 'get'),
      ...errorCodes('/api/v1/activities', 'post'),
      ...errorCodes('/api/v1/activities/{activityId}', 'patch'),
    ]);
    expect([...codes], 'the record operations declare no error codes').toEqual(
      expect.arrayContaining(['not_found', 'not_permitted', 'stale_write', 'validation_failed']),
    );
    const missing = [...codes].filter((code) => en[`records.error.${code}`] === undefined);
    expect(missing, 'en.json lacks records.error.<code> for these record errors').toEqual([]);
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

describe('acceptance: T-0063 — no colour literal and no device storage in the slice', () => {
  it('the colour detector catches what the lint rule misses', () => {
    // Planted first: a detector only ever seen finding nothing proves nothing.
    for (const planted of [
      'className="text-[#c00] p-2"',
      "style={{ color: 'red' }}",
      'className="bg-red-500"',
      "const ring = 'rgb(200 0 0)';",
      'className="border-white"',
    ]) {
      expect(colourLiterals(planted), `the detector missed ${planted}`).not.toEqual([]);
    }
    expect(colourLiterals('className="bg-surface text-text-2 border-border-strong text-danger-text"')).toEqual([]);
  });

  it('the slice reaches the screen through its imports, and stops at the shared shells', () => {
    const slice = screenSlice();
    const files = slice.map(({ file }) => file);
    expect(files).toContain(recordPage() ?? '<no page>');
    expect(files.filter((file) => SHARED_SHELLS.some((shell) => file.startsWith(shell)))).toEqual([]);
    expect(files.length, 'the slice is the route file alone: nothing it imports was followed').toBeGreaterThan(1);
  });

  it('writes no colour literal anywhere in the slice', () => {
    const found = screenSlice().flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the account record slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('touches no device-storage API (D-L64, D-P21)', () => {
    const storage = /\b(localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|navigator\.storage|document\.cookie)\b/;
    const found = screenSlice().filter(({ source }) => storage.test(withoutComments(source))).map(({ file }) => file);
    expect(found, 'the account record slice uses a device-storage API: the record lives in memory only').toEqual([]);
  });
});

// ===========================================================================
// 4. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0063 — the journeys and the mock are the ones this suite was written with', () => {
  it('pins p05-account.spec.ts and account-record-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(
        normalisedHash(file),
        `${file} changed. It is part of the T-0063 acceptance contract: ask the lead to re-pin it ` +
          '(only ACCOUNT_RECORD_BUDGET_BYTES may move without that).',
      ).toBe(pinned);
    }
    const mock = readFileSync(fromRoot(MOCK), 'utf8');
    expect(mock, 'the mock no longer reads the records contract').toContain(CONTRACT);
    expect(mock, 'the mock no longer checks its own answers against the contract').toMatch(/answerProblems\(operation, status, body\)/);
  });
});

// ===========================================================================
// 5. The tag is this screen's alone (D-L84)
// ===========================================================================

describe('acceptance: T-0063 — @p05-account selects these journeys and nothing else', () => {
  it('no other spec carries a tag @p05-account matches, ours matches no other parent tag, and the spec carries only ours', () => {
    // Passes before the work starts: it guards later screens against
    // colliding with this one, as `@p04` once collided with `@p04-accounts`.
    const specs = trackedFiles('tests/e2e').filter((file) => file.endsWith('.spec.ts') && existsSync(fromRoot(file)));
    expect(specs).toContain(SPEC);
    const ours = tagsIn(SPEC).filter((tag) => /^@p\d/.test(tag));
    expect(ours.length).toBeGreaterThan(REQUIRED.length);
    expect(ours.filter((tag) => !tag.startsWith(E2E_TAG)), 'the spec carries another screen’s tag').toEqual([]);
    const clashes = specs
      .filter((file) => file !== SPEC)
      .flatMap((file) => tagsIn(file).filter((tag) => tag.includes(E2E_TAG)).map((tag) => `${file}: ${tag}`));
    expect(clashes, `--grep ${E2E_TAG} would also run these`).toEqual([]);
    for (const other of OTHER_PARENT_TAGS) {
      expect(new RegExp(other).test(E2E_TAG), `--grep ${other} runs this screen`).toBe(false);
      expect(ours.filter((tag) => new RegExp(other).test(tag)), `--grep ${other} runs these journeys`).toEqual([]);
    }
  });
});

// ===========================================================================
// 6. The browser — one run of @p05-account
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0063 e2e run did not start', outcomes: undefined, startedAt: 0 };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

function outcomes(): E2eOutcome[] {
  expect(
    e2eRun.outcomes,
    `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-6000)}`,
  ).toBeDefined();
  return e2eRun.outcomes ?? [];
}

describe('acceptance: T-0063 — the account record in a browser', () => {
  beforeAll(() => {
    rmSync(OUTCOMES_FILE, { force: true });
    rmSync(fromRoot(BUDGET_RECORD), { force: true });

    // Relative to tests/e2e, where run-e2e.mjs starts Playwright.
    const reporter = relative(
      fromRoot('tests', 'e2e'),
      fromRoot('tests', 'acceptance', 'support', 'e2e-outcomes-reporter.ts'),
    ).replace(/\\/g, '/');

    const startedAt = Date.now();
    const run = spawnSync(
      process.execPath,
      [fromRoot('tests', 'e2e', 'scripts', 'run-e2e.mjs'), '--grep', E2E_TAG, `--reporter=list,${reporter}`],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: false,
        timeout: E2E_RUN_TIMEOUT_MS,
        // A production build plus a Playwright list reporter overflows the
        // 1 MB default, and an overflow kills the child mid-run.
        maxBuffer: 256 * 1024 * 1024,
      },
    );

    e2eRun = {
      status: run.status,
      output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error === undefined ? '' : `\n[spawn] ${run.error.message}`}`,
      outcomes: existsSync(OUTCOMES_FILE)
        ? (JSON.parse(readFileSync(OUTCOMES_FILE, 'utf8')) as E2eOutcome[])
        : undefined,
      startedAt,
    };
  }, E2E_RUN_TIMEOUT_MS);

  it('runs every @p05-account journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(journeys.length, 'the run reported fewer @p05-account tests than there are behaviours').toBeGreaterThanOrEqual(
      REQUIRED.length,
    );
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p05-account tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter(
        (outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag),
      );
      expect(proving.length, `no PASSING @p05-account test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('pins /accounts/[id] at or under 245,000 bytes and within 5% of what this run measured', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'ACCOUNT_RECORD_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /accounts/[id] budget is above its ceiling').toBeLessThanOrEqual(ACCOUNT_RECORD_BUDGET_CEILING);
    expect(budget).toBeLessThan(PRD_CEILING_BYTES);

    const record = fromRoot(BUDGET_RECORD);
    expect(existsSync(record), 'the budget test wrote no measurement').toBe(true);
    expect(statSync(record).mtimeMs, 'the measurement is older than this run').toBeGreaterThanOrEqual(e2eRun.startedAt);
    const measured = (JSON.parse(readFileSync(record, 'utf8')) as { transferredBytes: number }).transferredBytes;
    expect(measured, 'the measurement is empty').toBeGreaterThan(0);
    expect(budget, `the budget is under the ${measured} bytes measured`).toBeGreaterThanOrEqual(measured);
    expect(
      budget,
      `the budget is more than 5% over the ${measured} bytes measured — re-pin ACCOUNT_RECORD_BUDGET_BYTES`,
    ).toBeLessThanOrEqual(Math.round(measured * BUDGET_HEADROOM));
  });
});
