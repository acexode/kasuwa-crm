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
 * ACCEPTANCE — T-0058, the P04 Leads screen (Agent 11, Frontend & Design
 * System). Decisions: D-P1, D-P13, D-P14, D-P17, D-P18, D-P21, D-L62, D-L64,
 * D-L69, D-L75, D-L80, D-L82, D-L84, D-L85.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. `crm_leads`: a registered flag, DEFAULT OFF, NOT production-ready,
 *      read on the server through `lib/feature-flags.ts`. `/leads` calls
 *      `notFound()` and is gated on it by name: with every flag at its default
 *      the route is a real 404. `crm_records` alone does not satisfy this.
 *   2. The e2e harness publishes `webLeadsUrl`: the SAME production build,
 *      `crm_leads` in KASUWA_FEATURE_FLAGS_ON (NODE_ENV=test, as D-L64 ruled).
 *      The default server stays flagless.
 *   3. The browser reads leads and converts them same-origin
 *      (`/api/v1/leads`, `/api/v1/contacts/{id}/convert`), Zod-parsed, with no
 *      scope argument.
 *   4. P04/01, 04, 05 and 06 against the contract mock — by e2e tag
 *      (section 6): the table (Contact columns including `companyName`, search
 *      by name, number or company sending `q`, chips that are exactly
 *      listLeads' `owner`, `status` and `source`, status offering the four lead
 *      stages only, sort on never-withheld keys, keyset paging, no counts);
 *      the Kanban (one column per lead stage, each read on its own, a drag
 *      sending exactly `{ version, status }` through updateContact, the next
 *      move sending the version the last one was served, a refusal rolled
 *      back with a translated alert, a non-drag move control); convert (an
 *      existing account by picker, from the lead's programme only, or a new
 *      one by name, through `convertContact` alone; 403, 409, 404 and 400
 *      `already_linked` as translated alerts; a retry after a lost answer
 *      taken as done with one account); field-security locks, never blank;
 *      empty, no-results, loading and error states; offline in memory only
 *      with edits, converts and drags disabled and nothing queued; Merge,
 *      Lead score, Map, bulk WhatsApp, Health and live counts hidden; no UUID
 *      printed; axe-clean; 360 px; en-XA; the byte budget.
 *   5. i18n: the literal-string rule fires on the route; every message id the
 *      slice names is in every design-menu catalogue, with a label for each
 *      lead stage, for the Company column and for `already_linked`; every
 *      error the operations answer is localised; no language falls off the
 *      menu (D-P1).
 *   6. No colour literal (wider than the lint rule, D-L84) and no
 *      device-storage API in the slice.
 *
 * PINNED INTERFACES (the builder's side): the DOM hooks and the `webLeadsUrl`
 * stack key listed in the header of `tests/e2e/p04-leads.spec.ts`; the route
 * file `apps/web/app/(group)/leads/page.tsx`; a P04/01 screen in the slice
 * (`data-screen="P04/01"`); lead-stage labels under a message id ending
 * `.status.<code>` (T-0042's `records.status.*` count); a Company column label
 * ending `.col.companyName` or `.field.companyName`; an `already_linked`
 * message under an id ending `.already_linked` or `.alreadyLinked`.
 *
 * BUILDER'S CHOICES: a new Next process or `crm_leads` on an existing one
 * (every link on the page must still resolve there, and every process's nav
 * must link only to routes it serves); whether `crm_leads` also needs
 * `crm_records`; how the Kanban drags (the platform's drag events or a
 * library — a new dependency needs its one-line justification, and the byte
 * budget leaves little room for one in the initial load); the move control's
 * menu; a sort menu or sortable headers; whether the convert sheet prefills
 * the new account's name from `companyName` (the contract allows it); whether
 * the converted lead's account is shown in the table (if it is, by name);
 * where the leads client lives; the copy.
 *
 * THE SLICE. Every apps/web module the `/leads` route directory imports,
 * transitively by relative import, except the shared shells
 * (`components/auth`, `components/crm`, `components/admin`), which other
 * suites hold. If the screen reuses the Contacts list's components, they are
 * in the slice too and held to the same rules. It must contain the P04/01
 * screen itself.
 *
 * NOT HELD HERE, AND WHY
 *   - "Non-writers see no convert": D-L84, the capability-read gap (T-0079).
 *     Write controls show to every caller and the 403 is the gate; the e2e
 *     refusals hold that. A lead whose `accountId` or `status` is WITHHELD is
 *     different — the row itself says the caller cannot write it — and there
 *     convert must not be offered (`@leads-p04-convert-locked`).
 *   - P04/01's inline Owner edit and bulk bar. T-0058 names the Kanban move as
 *     the one contact write; the mock refuses any other.
 *
 * THE BROWSER HALF. `tests/e2e/p04-leads.spec.ts` (journeys) and
 * `tests/e2e/support/leads-mock.ts` (the contract mock) were written with this
 * suite and are PINNED by hash below, because `tests/e2e` is not
 * path-protected (D-L64). LEADS_BUDGET_BYTES is the one line the builder may
 * change, and only downwards towards the measurement (section 6).
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @leads-p04 --reporter=list,<ours>
 *
 * spawned with `shell: false` and the arguments as an array: one tag, no shell
 * metacharacter (D-L62). Every test is read from the outcomes file our
 * reporter writes, so a skipped, `fixme`d or unmatched test never counts.
 * THE TAG IS `@leads-p04`, NOT `@p04-leads` (D-L84): `--grep @p04` (T-0042) and
 * `--grep @p04-accounts` (T-0057) select nothing here, and no other spec's tag
 * contains this one (section 5 checks all three).
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const FLAG = 'crm_leads';

const E2E_TAG = '@leads-p04';

/** Other screens' parent tags, whose --grep must not select this screen (D-L84). */
const OTHER_PARENT_TAGS = ['@p04', '@p04-accounts', '@p05-contact'];

/** `next build` (SWC wasm on the dev host, D-L62), a container, the servers and the journeys. */
const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p04-leads.spec.ts';
const MOCK = 'tests/e2e/support/leads-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/leads-p04-budget.json';
const CONTRACT = 'docs/api/records.openapi.yaml';

/**
 * The pinned browser half (CRLF folded to LF; the budget literal normalised).
 * A change to either file is a change to the acceptance contract: the lead
 * re-pins it, the builder does not.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  [SPEC]: '436e93ce688fe1847fd539d4119cf01b26ca5d889c6f8a522f857b4d5a36a458',
  [MOCK]: '51dd1cf0ca52a71a421479aa36e9c40cbec84a2475c171606f3382e88ea000b3',
};

/** See the budget test in the spec for the derivation. Never above this. */
const LEADS_BUDGET_CEILING = 255_000;

/** Re-pinned within 5% of what the run measured, like /contacts (T-0042) and P01/1 (T-0035). */
const BUDGET_HEADROOM = 1.05;

const PRD_CEILING_BYTES = 300 * 1024;

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the mock's validators
  // reject malformed requests, so every afterEach "no violations" means something.
  ['@leads-p04-mock', 'the contract mock refuses what the contract refuses'],
  ['@leads-p04-flag-off', '/leads is a 404 with crm_leads at its default, and the browser cannot flip it'],
  ['@leads-p04-flag-on', '/leads renders with crm_leads on'],
  ['@leads-p04-shell', 'the CRM shell, Leads current in its nav, no link a 404'],
  ['@leads-p04-columns', 'Contact columns incl. companyName, names and labels not ids or codes, markup as text, axe-clean'],
  ['@leads-p04-search', 'search by name, number or company sends q (at most 100), out of the URL and title'],
  ['@leads-p04-filters', 'chips are exactly owner, status, source; status the four lead stages; no counts; field_withheld is an error'],
  ['@leads-p04-sort', 'sort only by never-withheld keys; a new sort drops the cursor'],
  ['@leads-p04-locked', 'a withheld field is a lock, per row, never empty; a null is never a lock'],
  ['@leads-p04-paging', 'nextCursor paging, echoed exactly, kept out of the URL, no total, q and filters kept'],
  ['@leads-p04-kanban', 'one column per lead stage, each read alone and paged alone, no counts, axe-clean'],
  ['@leads-p04-drag', 'a drag sends exactly { version, status }; the next sends the served version; same column sends nothing'],
  ['@leads-p04-drag-refusals', 'a refused move rolls the card back, with a translated alert'],
  ['@leads-p04-move-menu', 'a non-drag move by pointer and keyboard (WCAG 2.5.7)'],
  ['@leads-p04-convert-existing', 'convert to an existing account picked by name, from the lead’s programme only, once'],
  ['@leads-p04-convert-new', 'convert to a new account by name through convertContact alone'],
  ['@leads-p04-convert-repeat', 'a retry after a lost answer re-sends and is taken as done, one account created'],
  ['@leads-p04-convert-refusals', '403, 409, 404 and 400 already_linked as translated alerts, the sheet kept'],
  ['@leads-p04-convert-locked', 'no convert on a lead whose account link is withheld'],
  ['@leads-p04-empty', 'P04/05 empty, even with a customer on file'],
  ['@leads-p04-no-results', 'P04/05 no results, naming the search and the filter'],
  ['@leads-p04-loading', 'P04/06 skeleton rows; a failed read is not "no leads"'],
  ['@leads-p04-offline', 'offline: memory only, last synced, edits, converts and drags disabled, nothing queued'],
  ['@leads-p04-hidden', 'no Merge, Lead score, Map, bulk WhatsApp, Health or live counts'],
  ['@leads-p04-mobile', '360 px: no sideways scroll, axe-clean, both views'],
  ['@leads-p04-pseudo', 'en-XA renders pseudo text on the table and the Kanban'],
  ['@leads-p04-budget', '/leads inside its byte budget on the production build'],
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

/** The App Router page for `/leads` (a route group such as `(crm)` allowed). */
function leadsPage(): string | undefined {
  return trackedFiles('apps/web/app').find((file) =>
    /^apps\/web\/app\/(?:\([\w-]+\)\/)*leads\/page\.tsx$/.test(file),
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
  const page = leadsPage();
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

/** The slice, refused unless it contains the P04/01 screen itself. */
function screenSlice(): SourceFile[] {
  const slice = sliceSources();
  expect(leadsPage(), 'there is no apps/web/app/**/leads/page.tsx').toBeDefined();
  expect(
    slice.filter(({ source }) => withoutComments(source).includes('P04/01')).map(({ file }) => file),
    'the /leads route imports no P04/01 screen (data-screen="P04/01")',
  ).not.toEqual([]);
  return slice;
}

/** apps/web/lib modules that read leads or convert one. */
function leadClients(): SourceFile[] {
  return webSources().filter(
    ({ file, source }) =>
      file.startsWith('apps/web/lib/') && /\/api\/v1\/leads|\/convert\b/.test(withoutComments(source)),
  );
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8'),
  ) as Record<string, string>;
}

const BUDGET_LITERAL = /const LEADS_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(BUDGET_LITERAL, 'const LEADS_BUDGET_BYTES = <budget>;');
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

type Json = Record<string, unknown>;

interface Contract {
  paths: Record<string, Record<string, { parameters?: Json[]; responses: Record<string, { $ref?: string }> }>>;
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

/** listLeads' `status` enum: the four lead stages. */
function leadStatuses(): string[] {
  const parameters = contract().paths['/api/v1/leads']?.get?.parameters ?? [];
  const status = parameters.find((parameter) => parameter.name === 'status') as
    | { schema?: { items?: { enum?: string[] } } }
    | undefined;
  return status?.schema?.items?.enum ?? [];
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

/** Tags written in a spec's code (comments stripped): test tags only, not package scopes. */
function tagsIn(file: string): string[] {
  return [...withoutComments(readFileSync(fromRoot(file), 'utf8')).matchAll(/@[a-z0-9][\w-]*/gi)]
    .map((match) => match[0])
    .filter((tag) => /^@(p\d|leads)/i.test(tag));
}

// ===========================================================================
// 1. The flag and the route
// ===========================================================================

describe('acceptance: T-0058 — crm_leads exists, is off, is not production-ready, and gates /leads', () => {
  it('registers crm_leads, not production-ready, and it evaluates OFF by default', async () => {
    // `true` as the fallback on purpose: an unregistered flag returns the
    // fallback, so only a flag that is registered AND defaults off answers false.
    expect(Object.keys(FLAGS), `${FLAG} is not declared in FLAGS`).toContain(FLAG);
    const definition = (FLAGS as Readonly<Record<string, { productionReady?: boolean; defaultValue?: boolean }>>)[FLAG];
    expect(definition?.defaultValue, `${FLAG} does not default off`).toBe(false);
    expect(definition?.productionReady, `${FLAG} is marked production-ready`).toBe(false);
    await initialiseFeatureFlags();
    const value = await featureFlagClient().getBooleanValue(
      FLAG,
      true,
      toEvaluationContext({ tenantId: 'acceptance-probe' }),
    );
    expect(value, `${FLAG} does not evaluate OFF by default`).toBe(false);
  });

  it('is read through lib/feature-flags.ts and never by a client module; /leads calls notFound() on crm_leads', () => {
    const flagModule = withoutComments(readFileSync(fromRoot('apps/web/lib/feature-flags.ts'), 'utf8'));
    const named = new RegExp(`['"]${FLAG}['"]`);
    const clientEvaluators = webSources().filter(
      ({ source }) => /^\s*['"]use client['"]/m.test(source) && source.includes(FLAG),
    );
    expect(
      clientEvaluators.map(({ file }) => file),
      'a client module names crm_leads — flags are read on the server only',
    ).toEqual([]);

    // The exported readers whose body evaluates crm_leads by name.
    const readers = [...flagModule.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)]
      .filter((match) => named.test(match[2] ?? ''))
      .map((match) => match[1] ?? '');

    const page = leadsPage();
    expect(page, 'there is no apps/web/app/**/leads/page.tsx').toBeDefined();
    const source = withoutComments(readFileSync(fromRoot(page ?? 'missing'), 'utf8'));
    // A gated ROUTE, not a hidden link, on ITS flag: a dedicated reader, or a
    // generic one called with the flag's name; never crm_records alone.
    expect(source, `${page} does not call notFound()`).toMatch(/\bnotFound\s*\(/);
    expect(source, `${page} imports nothing from lib/feature-flags`).toMatch(/from ['"][./]*lib\/feature-flags['"]/);
    const gated = readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source)) || named.test(source);
    expect(gated, `${page} is not gated on crm_leads (readers found: ${readers.join(', ') || 'none'})`).toBe(true);
  });

  it('starts a crm_leads web process, publishes webLeadsUrl, and leaves the default server flagless', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    expect(runner, 'run-e2e.mjs starts no web process with crm_leads in KASUWA_FEATURE_FLAGS_ON').toMatch(
      /KASUWA_FEATURE_FLAGS_ON:\s*['"`][^'"`]*\bcrm_leads\b/,
    );
    expect(runner, 'run-e2e.mjs does not publish webLeadsUrl in the stack file').toContain('webLeadsUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(
      /KASUWA_FEATURE_FLAGS_ON:\s*''/,
    );
  });

  it('reads leads and converts them same-origin, Zod-parsed, with no scope argument', () => {
    const clients = leadClients();
    const code = (file: string) => withoutComments(clients.find((entry) => entry.file === file)?.source ?? '');
    expect(
      clients.filter(({ source }) => withoutComments(source).includes('/api/v1/leads')).map(({ file }) => file),
      'no apps/web/lib module reads /api/v1/leads',
    ).not.toEqual([]);
    expect(
      clients.filter(({ source }) => /\/convert\b/.test(withoutComments(source))).map(({ file }) => file),
      'no apps/web/lib module calls /api/v1/contacts/{id}/convert',
    ).not.toEqual([]);
    for (const { file } of clients) {
      expect(code(file), `${file} names an absolute API origin`).not.toMatch(/https?:\/\/[^'"`]*\/api\/v1/);
      expect(code(file), `${file} does not parse with Zod`).toMatch(/from ['"]zod['"]/);
      // A programme in a query string, a header or a list of them is scope from the client.
      expect(code(file), `${file} builds a scope argument`).not.toMatch(
        /programmeIds|(set|append)\(\s*['"`]programme|['"`]x-[\w-]*(programme|tenant)/i,
      );
    }
    for (const { file: name, source } of webSources()) {
      expect(withoutComments(source), `${name} imports test support`).not.toMatch(
        /from ['"][^'"]*(tests\/e2e|leads-mock|records-mock|@kasuwa\/testing)[^'"]*['"]/,
      );
    }
  });
});

// ===========================================================================
// 2. i18n — the lint rule, every catalogue, D-P1
// ===========================================================================

describe('acceptance: T-0058 — every string through i18n, in every catalogue, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the /leads route file', () => {
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(
      /files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/,
    );
    // A rule only ever seen passing proves nothing. Plant a literal at the
    // route's own path and watch it fail.
    const page = leadsPage();
    expect(page, 'there is no apps/web/app/**/leads/page.tsx').toBeDefined();
    const planted = eslint(
      ['--stdin', '--stdin-filename', page ?? 'apps/web/app/leads/page.tsx', '--format', 'json'],
      'export default function Planted() {\n  return <p>Convert lead</p>;\n}\n',
    );
    expect(planted.output, `a literal JSX string at ${page} is not rejected:\n${planted.output.slice(-2000)}`).toContain(
      'i18next/no-literal-string',
    );
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const slice = screenSlice();
    const run = eslint(['--max-warnings', '0', ...slice.map(({ file }) => file)]);
    expect(run.status, `eslint fails on the leads slice:\n${run.output.slice(-4000)}`).toBe(0);

    // jsx-text-only cannot see attributes; an English aria-label is still English.
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('puts every message the slice names, a label for each lead stage, the Company column and already_linked, in every design-menu catalogue', async () => {
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
    expect(named.size, 'the leads slice names almost no message id').toBeGreaterThan(10);

    const stages = leadStatuses();
    expect(stages, 'the contract lists no lead stages').toEqual(['new', 'contacted', 'qualified', 'unqualified']);
    const required = [
      ...stages.map((stage) => ({ what: `the ${stage} stage`, match: (id: string) => id.endsWith(`.status.${stage}`) })),
      {
        what: 'the Company column (an id ending ".col.companyName" or ".field.companyName")',
        match: (id: string) => id.endsWith('.col.companyName') || id.endsWith('.field.companyName'),
      },
      {
        what: 'the already_linked refusal (an id ending ".already_linked" or ".alreadyLinked")',
        match: (id: string) => id.endsWith('.already_linked') || id.endsWith('.alreadyLinked'),
      },
    ].map(({ what, match }) => {
      const key = Object.keys(en).find(match);
      expect(key, `en.json has no label for ${what}`).toBeDefined();
      return key ?? `<missing: ${what}>`;
    });

    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const key of [...named, ...required]) {
        if (typeof messages[key] !== 'string' || messages[key].trim() === '') {
          missing.push(`${locale}: ${key}`);
        }
      }
    }
    expect(missing, 'message ids the leads screen uses that a catalogue lacks').toEqual([]);
  });

  it('localises every error the leads operations can answer with', () => {
    // NOTE: passes before the work starts — T-0042 already added records.error.*
    // for every shared code. It is here so a new code in the contract (or a
    // dropped key) fails this suite rather than reaching a user as a raw code.
    const en = catalogue('en');
    const codes = new Set([
      ...errorCodes('/api/v1/leads', 'get'),
      ...errorCodes('/api/v1/contacts/{contactId}/convert', 'post'),
      ...errorCodes('/api/v1/contacts/{contactId}', 'patch'),
      ...errorCodes('/api/v1/contacts/{contactId}', 'get'),
      ...errorCodes('/api/v1/accounts', 'get'),
    ]);
    expect([...codes], 'the leads operations declare no error codes').toEqual(
      expect.arrayContaining(['not_found', 'not_permitted', 'stale_write', 'validation_failed']),
    );
    const missing = [...codes].filter((code) => en[`records.error.${code}`] === undefined);
    expect(missing, 'en.json lacks records.error.<code> for these leads errors').toEqual([]);
  });

  it('drops no design-menu language from the menu (D-P1)', async () => {
    // New English keys make every draft catalogue incomplete, and an incomplete
    // language silently leaves MENU_LOCALES. (It passes before the work starts,
    // too: it guards against the work, not for it.)
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

describe('acceptance: T-0058 — no colour literal and no device storage in the slice', () => {
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
    // And what the codebase does already is not a colour literal.
    expect(colourLiterals('className="bg-surface text-text-2 border-border-strong text-danger-text"')).toEqual([]);
  });

  it('the slice reaches the screen through its imports, and stops at the shared shells', () => {
    // The slice resolver is itself a check that could pass by finding nothing:
    // it must reach the route's own files and must not wander into the shells.
    const slice = screenSlice();
    const files = slice.map(({ file }) => file);
    expect(files).toContain(leadsPage() ?? '<no page>');
    expect(files.filter((file) => SHARED_SHELLS.some((shell) => file.startsWith(shell)))).toEqual([]);
    expect(files.length, 'the slice is the route file alone: nothing it imports was followed').toBeGreaterThan(1);
  });

  it('writes no colour literal anywhere in the slice', () => {
    const found = screenSlice().flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the leads slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('touches no device-storage API (D-L64, D-P21)', () => {
    const storage = /\b(localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|navigator\.storage|document\.cookie)\b/;
    const found = screenSlice().filter(({ source }) => storage.test(withoutComments(source))).map(({ file }) => file);
    expect(found, 'the leads slice uses a device-storage API: leads live in memory only').toEqual([]);
  });
});

// ===========================================================================
// 4. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0058 — the journeys and the mock are the ones this suite was written with', () => {
  it('pins p04-leads.spec.ts and leads-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(
        normalisedHash(file),
        `${file} changed. It is part of the T-0058 acceptance contract: ask the lead to re-pin it ` +
          '(only LEADS_BUDGET_BYTES may move without that).',
      ).toBe(pinned);
    }
    expect(readFileSync(fromRoot(MOCK), 'utf8'), 'the mock no longer reads the records contract').toContain(CONTRACT);
  });
});

// ===========================================================================
// 5. The tag is this screen's alone (D-L84)
// ===========================================================================

describe('acceptance: T-0058 — @leads-p04 selects these journeys and nothing else, and no other screen selects them', () => {
  it('the spec carries only @leads-p04 tags, no other spec carries one, and --grep @p04 / @p04-accounts select none of them', () => {
    // Passes before the work starts: it guards against the tag collision D-L84
    // records (`--grep @p04` once ran every `@p04-accounts` journey).
    const specs = trackedFiles('tests/e2e').filter((file) => file.endsWith('.spec.ts') && existsSync(fromRoot(file)));
    expect(specs).toContain(SPEC);
    const ours = tagsIn(SPEC);
    expect(ours.length, 'the spec carries almost no tags').toBeGreaterThan(REQUIRED.length);
    expect(ours.filter((tag) => !tag.startsWith(E2E_TAG)), 'the spec carries another screen’s tag').toEqual([]);
    for (const [tag] of REQUIRED) {
      expect(ours, `the spec never uses ${tag}`).toContain(tag);
    }

    // Playwright's --grep is a regex over the whole title. Nothing in the
    // spec's code — titles included — may contain another screen's parent tag.
    const code = withoutComments(readFileSync(fromRoot(SPEC), 'utf8'));
    for (const other of OTHER_PARENT_TAGS) {
      expect(new RegExp(other).test(E2E_TAG), `--grep ${other} selects ${E2E_TAG}`).toBe(false);
      expect(code.includes(other), `the spec's code contains "${other}", so --grep ${other} would run it`).toBe(false);
    }

    const clashes = specs
      .filter((file) => file !== SPEC)
      .flatMap((file) =>
        [...withoutComments(readFileSync(fromRoot(file), 'utf8')).matchAll(/@[a-z0-9][\w-]*/gi)]
          .map((match) => match[0])
          .filter((tag) => tag.includes(E2E_TAG))
          .map((tag) => `${file}: ${tag}`),
      );
    expect(clashes, `--grep ${E2E_TAG} would also run these`).toEqual([]);
  });
});

// ===========================================================================
// 6. The browser — one run of @leads-p04
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0058 e2e run did not start', outcomes: undefined, startedAt: 0 };

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

describe('acceptance: T-0058 — the leads screen in a browser', () => {
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

  it('runs every @leads-p04 journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(journeys.length, 'the run reported fewer @leads-p04 tests than there are behaviours').toBeGreaterThanOrEqual(
      REQUIRED.length,
    );
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@leads-p04 tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter(
        (outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag),
      );
      expect(proving.length, `no PASSING @leads-p04 test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('pins /leads at or under 255,000 bytes and within 5% of what this run measured', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'LEADS_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /leads budget is above its ceiling').toBeLessThanOrEqual(LEADS_BUDGET_CEILING);
    expect(budget).toBeLessThan(PRD_CEILING_BYTES);

    const record = fromRoot(BUDGET_RECORD);
    expect(existsSync(record), 'the budget test wrote no measurement').toBe(true);
    expect(statSync(record).mtimeMs, 'the measurement is older than this run').toBeGreaterThanOrEqual(
      e2eRun.startedAt,
    );
    const measured = (JSON.parse(readFileSync(record, 'utf8')) as { transferredBytes: number }).transferredBytes;
    expect(measured, 'the measurement is empty').toBeGreaterThan(0);
    expect(budget, `the budget is under the ${measured} bytes measured`).toBeGreaterThanOrEqual(measured);
    expect(
      budget,
      `the budget is more than 5% over the ${measured} bytes measured — re-pin LEADS_BUDGET_BYTES`,
    ).toBeLessThanOrEqual(Math.round(measured * BUDGET_HEADROOM));
  });
});
