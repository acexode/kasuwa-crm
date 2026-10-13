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
 * ACCEPTANCE — T-0115, the P10 script builder, frame P10/05 (Agent 11,
 * Frontend & Design System). Decisions: D-L88, D-L91, D-L93, D-L96, D-P32,
 * D-L97, D-L102.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. A new flag, `crm_scripts`: registered, default OFF, not
 *      production-ready. The routes `apps/web/app/(group)/scripts/page.tsx`
 *      and `.../scripts/[scriptId]/page.tsx` call `notFound()` and are gated
 *      on it, read on the server through `lib/feature-flags.ts`; no client
 *      module names it. A web process in run-e2e.mjs carries it (with
 *      `crm_records`, for the CRM shell) and the stack file publishes it as
 *      `webScriptsUrl`; the default server stays flagless.
 *   2. The browser reads and writes the authoring API (T-0113) same-origin,
 *      Zod-parsed, with no scope argument; no apps/web module imports test
 *      support.
 *   3. P10/05 against the contract mock, by e2e tag (section 6): the list
 *      (draft and published state, keyset, no counts); create in a programme
 *      chosen by name; the admin set only (a non-writer's editor reads are the
 *      generic not-found and create is a translated 403); the node editor (the
 *      six kinds, no disposition node; branch conditions chosen from Contact
 *      field references and the contract's operators, never typed; variables
 *      from the three families only; form fields with no record binding,
 *      D-P31); D-L102 saves (revision plus changed fields only, re-read and
 *      re-apply after a 409, "changed by someone else"); publish (an immutable
 *      version; refused reasons in words, nodes marked by title); the
 *      read-only version list; the compliance diff by name; translations per
 *      design locale, saved whole; hidden features; loading; offline; 360 px;
 *      en-XA; the byte budget.
 *   4. i18n: the literal-string rule fires on the route; every message id the
 *      slice names is in every design-menu catalogue, and so is a label for
 *      every node kind, condition operator, form field type and publish
 *      reason, and a `scripting.error.<code>` for every code the authoring
 *      operations answer (the contract: "The web app localises as
 *      `scripting.error.<code>`").
 *   5. No colour literal and no device-storage API in the slice.
 *
 * PINNED INTERFACES (the builder's side): the DOM hooks in the header of
 * `tests/e2e/p10-builder.spec.ts`; the routes above; node kinds labelled under
 * an id ending `.nodeType.<type>`, operators `.operator.<op>`, form field
 * types `.fieldType.<type>`, publish reasons `.reason.<code>`, and every
 * Contact field a branch offers under an id ending `.field.<name>`.
 *
 * RULINGS BEYOND THE TASK FILE (for the lead; the suite is written to them)
 *
 *   R1. Routes: `/scripts` (list) and `/scripts/[scriptId]` (editor), in the
 *       CRM shell. A version is shown inside the editor route, not its own.
 *   R2. "A real 404 for anyone else" cannot be met yet. No read tells the web
 *       process or the screen who holds `script.write` (T-0079, D-L84):
 *       listScripts answers a non-writer exactly as it answers an admin with
 *       no scripts. What IS pinned: the editor's reads answer a non-writer
 *       404, drawn as the generic not-found (one heading for non-writer,
 *       another programme and missing); a non-uuid id is a real 404 that
 *       reads nothing; create is a translated 403 (D-L84: the control shows
 *       to every caller). `@p10-builder-access-404` is a `fixme` until T-0079.
 *   R3. "No nav entry": the CRM navigation carries NO entry to the builder,
 *       for anyone, until a capability read exists. An entry shown to agents
 *       would lead them to an empty list; one shown to nobody costs the admin
 *       set a typed URL. Revisit with T-0079.
 *   R4. Saves are explicit (a save control), never automatic. D-L102 is
 *       judged per save; an autosave on a 256 kbps link would also resend a
 *       draft of up to 256 KiB on every keystroke pause.
 *   R5. "Changed fields only" for a draft is judged at the top level of
 *       UpdateScriptRequest (`name`, `sourceLocale`, `graph`), because the
 *       contract replaces the whole graph. Inside the graph, the rebase after
 *       a 409 is per node: a node this person never touched is sent exactly
 *       as the re-read served it, and one both changed keeps the typed value
 *       with the "changed by someone else" note.
 *   R6. A node added from the palette is shape-valid at once (two choices,
 *       one field, a condition), so a save right away is never a 400.
 *       Completeness is publish's (`409 script_invalid`).
 *   R7. Publish is offered only when the draft has `hasUnpublishedChanges`
 *       and no unsaved edit: publishing snapshots the SERVER's draft, so an
 *       unsaved edit would silently not be in the version.
 *   R8. The compliance diff compares the draft with the latest version read
 *       through getScriptVersion, by node title (added, changed, removed).
 *   R9. A suggested disposition (end node) is chosen from admin's
 *       listProgrammeDispositions for the script's programme, by label. The
 *       scripting contract has no disposition read for authors; the mock
 *       serves that one admin operation.
 *   R10. Translations: a tab per design locale other than the source, at
 *       least ha, yo, ig, pcm and fr (sw is the builder's choice). The save
 *       control PUTs only the locales that changed, each WHOLE: every node
 *       translation it was served is sent back.
 *   R11. Provisional budget: /scripts/[scriptId] at or under 260,000 B,
 *       re-pinned within 5% of the first measurement.
 *
 * BUILDER'S CHOICES: the layout (canvas, inspector, panels); whether the
 * canvas can be dragged (positions are layout only); whether the list shows
 * the programme (by name if it does); the copy; where the authoring client
 * lives (a `lib/` module).
 *
 * THE SLICE. Every apps/web module the `/scripts` route directory imports,
 * transitively by relative import, except the shared shells
 * (`components/auth`, `components/crm`, `components/admin`). It must contain
 * the P10/05 screen (a module naming `P10/05`).
 *
 * THE BROWSER HALF. `tests/e2e/p10-builder.spec.ts` (journeys) and
 * `tests/e2e/support/scripting-mock.ts` (the contract mock, shared with
 * T-0116, which checks every answer it gives against the YAML) were written
 * with this suite and are PINNED by hash below, because `tests/e2e` is not
 * path-protected (D-L64). SCRIPT_BUILDER_BUDGET_BYTES is the one line that may
 * change without a re-pin, and only downwards towards the measurement.
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p10-builder --reporter=list,<ours>
 *
 * spawned with `shell: false` (D-L62); every test is read from the outcomes
 * file our reporter writes, so a skipped, `fixme`d or unmatched test never
 * counts.
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const FLAG = 'crm_scripts';
const SHELL_FLAG = 'crm_records';

const E2E_TAG = '@p10-builder';

/** Every other screen's parent tag. None may contain ours, and ours may contain none (D-L84). */
const OTHER_PARENT_TAGS = ['@p01', '@p02', '@p04', '@p04-accounts', '@p05-contact', '@p05-account', '@leads-p04', '@p10-agent'];

const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p10-builder.spec.ts';
const MOCK = 'tests/e2e/support/scripting-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/p10-builder-budget.json';
const CONTRACT = 'docs/api/scripting.openapi.yaml';

/** The pinned browser half (CRLF folded to LF; the budget literal normalised). */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  [SPEC]: 'a001183d23ce766d00d81301dd1258972171329bfcb7162f16848567a18e6048',
  [MOCK]: 'e4339089f35fab5bc47aad42ddaedc2663e36ba991fdbf56b18fb7132fc93574',
};

const SCRIPT_BUILDER_BUDGET_CEILING = 260_000;
const BUDGET_HEADROOM = 1.05;
const PRD_CEILING_BYTES = 300 * 1024;

/** The authoring operations the builder calls (T-0113). */
const OPERATIONS: readonly (readonly [path: string, method: string])[] = [
  ['/api/v1/scripts', 'get'],
  ['/api/v1/scripts', 'post'],
  ['/api/v1/scripts/{scriptId}', 'get'],
  ['/api/v1/scripts/{scriptId}', 'patch'],
  ['/api/v1/scripts/{scriptId}/versions', 'get'],
  ['/api/v1/scripts/{scriptId}/versions', 'post'],
  ['/api/v1/scripts/{scriptId}/versions/{versionId}', 'get'],
  ['/api/v1/scripts/{scriptId}/translations/{locale}', 'put'],
];

/** publishScript's `script_invalid` reasons (its description; the mock checks the same list). */
const PUBLISH_REASONS = [
  'missing_start',
  'empty_script',
  'unknown_target',
  'unreachable_end',
  'cycle',
  'unknown_field',
  'unknown_variable',
  'disposition_not_live',
  'unchanged',
  'sensitive_field',
  'branch_on_withheld_field',
];

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the mock's validators
  // reject malformed requests and answers, so every afterEach means something.
  ['@p10-builder-mock', 'the contract mock refuses what the contract refuses and checks its own answers'],
  // Passes before the work starts too (no route): a negative invariant, given meaning by flag-on.
  ['@p10-builder-flag-off', '/scripts and /scripts/<id> are 404s with every flag at its default, and the browser cannot flip them'],
  ['@p10-builder-flag-on', '/scripts renders the builder with crm_scripts on'],
  ['@p10-builder-shell', 'the CRM shell; no link a 404; no nav entry to the builder for anyone (R3)'],
  ['@p10-builder-list', 'scripts in served order with draft and published state, keyset "more", no count, no id'],
  ['@p10-builder-create', 'a draft created in a programme chosen by name, opened in the editor'],
  ['@p10-builder-access', 'a non-writer: no scripts, the generic not-found for every editor, a translated 403 to create'],
  ['@p10-builder-editor', 'the node graph by title and kind; the six kinds only; added nodes save shape-valid; markup as text'],
  ['@p10-builder-branch', 'branch conditions chosen from Contact field references and the contract operators, never typed'],
  ['@p10-builder-variables', 'variables from contact.*, agent.displayName and answer.* only; no loan.*'],
  ['@p10-builder-form', 'form fields collect answers on the run only: no record binding (D-P31)'],
  ['@p10-builder-save', 'revision plus the changed fields only; the next save carries the revision returned; no autosave'],
  ['@p10-builder-rebase', 'after a 409: re-read, the other person kept, this person re-applied, "changed by someone else"'],
  ['@p10-builder-publish', 'publish only for saved changes; an immutable version'],
  ['@p10-builder-invalid', 'a refused publish says its reasons in words and marks the nodes by title'],
  ['@p10-builder-versions', 'the version list newest first, keyset; a version read-only, writing nothing'],
  ['@p10-builder-diff', 'the draft’s compliance changes against the latest version, by name'],
  ['@p10-builder-translations', 'a tab per design locale; a translation saved whole for its locale only'],
  ['@p10-builder-hidden', 'no multi-programme publish, approver, AI, QA, hang-up, record binding, loan variable or sample'],
  ['@p10-builder-loading', 'skeleton; a failed read is not "not found"'],
  ['@p10-builder-offline', 'offline: memory only, every write disabled, nothing queued'],
  ['@p10-builder-mobile', '360 px: no sideways page scroll, axe-clean'],
  ['@p10-builder-pseudo', 'en-XA renders pseudo text on the builder'],
  ['@p10-builder-budget', '/scripts/[scriptId] inside its byte budget on the production build'],
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

function routePage(pattern: RegExp): string | undefined {
  return trackedFiles('apps/web/app').find((file) => pattern.test(file));
}

const LIST_ROUTE = /^apps\/web\/app\/(?:\([\w-]+\)\/)*scripts\/page\.tsx$/;
const EDITOR_ROUTE = /^apps\/web\/app\/(?:\([\w-]+\)\/)*scripts\/\[scriptId\]\/page\.tsx$/;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SHARED_SHELLS = ['apps/web/components/auth/', 'apps/web/components/crm/', 'apps/web/components/admin/'];

/** Every file in the route directories, and what they import by relative path, transitively, minus the shells. */
function sliceSources(): SourceFile[] {
  const pages = [routePage(LIST_ROUTE), routePage(EDITOR_ROUTE)].filter((page): page is string => page !== undefined);
  if (pages.length === 0) {
    return [];
  }
  const sources = new Map(webSources().map((entry) => [entry.file, entry.source]));
  const directories = pages.map((page) => posix.dirname(page));
  const queue = [...sources.keys()].filter((file) => directories.some((directory) => file.startsWith(`${directory}/`)));
  const seen = new Set<string>();
  const resolveImport = (from: string, specifier: string): string | undefined => {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    return [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) => sources.has(candidate));
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

function screenSlice(): SourceFile[] {
  const slice = sliceSources();
  expect(routePage(LIST_ROUTE), 'there is no apps/web/app/**/scripts/page.tsx').toBeDefined();
  expect(routePage(EDITOR_ROUTE), 'there is no apps/web/app/**/scripts/[scriptId]/page.tsx').toBeDefined();
  expect(
    slice.filter(({ source }) => withoutComments(source).includes('P10/05')).map(({ file }) => file),
    'the /scripts routes import no P10/05 screen (data-screen="P10/05")',
  ).not.toEqual([]);
  return slice;
}

/** apps/web/lib modules that talk to the scripting API. */
function scriptingClients(): SourceFile[] {
  return webSources().filter(({ file, source }) => file.startsWith('apps/web/lib/') && /\/api\/v1\/script/.test(withoutComments(source)));
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8')) as Record<string, string>;
}

const BUDGET_LITERAL = /const SCRIPT_BUILDER_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(BUDGET_LITERAL, 'const SCRIPT_BUILDER_BUDGET_BYTES = <budget>;');
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

type Json = Record<string, unknown>;

interface Contract {
  paths: Record<string, Record<string, Json & { responses: Record<string, { $ref?: string }> }>>;
  components: { responses: Record<string, Json>; schemas: Record<string, Json> };
}

function contract(): Contract {
  return parse(readFileSync(fromRoot(CONTRACT), 'utf8')) as Contract;
}

/** Error `code`s an operation can answer with: its response examples and its `x-kasuwa-error-order`. */
function errorCodes(path: string, method: string): string[] {
  const spec = contract();
  const operation = spec.paths[path]?.[method];
  expect(operation, `${method.toUpperCase()} ${path} is gone from the scripting contract`).toBeDefined();
  const codes = new Set<string>();
  for (const entry of (operation?.['x-kasuwa-error-order'] ?? []) as string[]) {
    const code = /^\d{3} ([a-z_]+)/.exec(entry)?.[1];
    if (code !== undefined) codes.add(code);
  }
  for (const [status, response] of Object.entries(operation?.responses ?? {})) {
    if (status.startsWith('2') || typeof response.$ref !== 'string') continue;
    const name = response.$ref.split('/').at(-1) ?? '';
    const body = (spec.components.responses[name]?.content as Json | undefined)?.['application/json'] as
      | { example?: { code?: string }; examples?: Record<string, { value?: { code?: string } }> }
      | undefined;
    for (const example of [body?.example, ...Object.values(body?.examples ?? {}).map((entry) => entry.value)]) {
      if (typeof example?.code === 'string') codes.add(example.code);
    }
  }
  return [...codes].sort();
}

function enumAt(schemaName: string, ...path: string[]): string[] {
  let node: unknown = contract().components.schemas[schemaName];
  for (const segment of path) {
    node = (node as Json | undefined)?.[segment];
  }
  return Array.isArray(node) ? node.filter((value) => value !== null).map(String) : [];
}

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

function eslint(args: readonly string[], input?: string): { status: number | null; output: string } {
  const require = createRequire(fromRoot('package.json'));
  const bin = resolve(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
  const run = spawnSync(process.execPath, [bin, ...args], { cwd: repoRoot, encoding: 'utf8', shell: false, input, maxBuffer: 64 * 1024 * 1024 });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error?.message ?? ''}` };
}

function readersOf(flag: string): string[] {
  const flagModule = withoutComments(readFileSync(fromRoot('apps/web/lib/feature-flags.ts'), 'utf8'));
  const named = new RegExp(`['"]${flag}['"]`);
  return [...flagModule.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)]
    .filter((match) => named.test(match[2] ?? ''))
    .map((match) => match[1] ?? '');
}

function gatedOn(source: string, flag: string): boolean {
  const readers = readersOf(flag).filter((name) => name !== 'crmLiveNav');
  return readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source)) || new RegExp(`['"]${flag}['"]`).test(source);
}

function tagsIn(file: string): string[] {
  return [...withoutComments(readFileSync(fromRoot(file), 'utf8')).matchAll(/@[a-z0-9][\w-]*/gi)].map((match) => match[0]);
}

// ===========================================================================
// 1. The flag and the routes
// ===========================================================================

describe('acceptance: T-0115 — /scripts is gated on crm_scripts', () => {
  it('registers crm_scripts, not production-ready, and OFF by default', async () => {
    await initialiseFeatureFlags();
    expect(Object.keys(FLAGS), `${FLAG} is not declared in FLAGS`).toContain(FLAG);
    const definition = (FLAGS as Readonly<Record<string, { productionReady?: boolean; defaultValue?: boolean }>>)[FLAG];
    expect(definition?.defaultValue, `${FLAG} does not default off`).toBe(false);
    expect(definition?.productionReady, `${FLAG} is marked production-ready`).toBe(false);
    // `true` as the fallback on purpose: only a registered, default-off flag answers false.
    const value = await featureFlagClient().getBooleanValue(FLAG, true, toEvaluationContext({ tenantId: 'acceptance-probe' }));
    expect(value, `${FLAG} does not evaluate OFF by default`).toBe(false);
  });

  it('has both route files, each calling notFound() and gated on crm_scripts, read on the server only', () => {
    for (const pattern of [LIST_ROUTE, EDITOR_ROUTE]) {
      const page = routePage(pattern);
      expect(page, `there is no route file matching ${String(pattern)}`).toBeDefined();
      const source = withoutComments(readFileSync(fromRoot(page ?? 'missing'), 'utf8'));
      expect(source, `${page} does not call notFound()`).toMatch(/\bnotFound\s*\(/);
      expect(source, `${page} imports nothing from lib/feature-flags`).toMatch(/from ['"][./]*lib\/feature-flags['"]/);
      expect(gatedOn(source, FLAG), `${page} is not gated on ${FLAG} (readers: ${readersOf(FLAG).join(', ') || 'none'})`).toBe(true);
    }
    const clientEvaluators = webSources().filter(({ source }) => /^\s*['"]use client['"]/m.test(source) && source.includes(FLAG));
    expect(clientEvaluators.map(({ file }) => file), 'a client module names crm_scripts — flags are read on the server only').toEqual([]);
  });

  it('serves the journeys from a process carrying crm_scripts and the CRM shell, and leaves the default server flagless', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    const processes = [...runner.matchAll(/KASUWA_FEATURE_FLAGS_ON:\s*['"`]([^'"`]*)['"`]/g)].map((match) => (match[1] ?? '').split(/[,\s]+/));
    expect(processes.some((flags) => flags.includes(FLAG) && flags.includes(SHELL_FLAG)), `no web process carries both ${FLAG} and ${SHELL_FLAG}`).toBe(true);
    expect(runner, 'run-e2e.mjs does not publish webScriptsUrl').toContain('webScriptsUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*''/);
  });

  it('talks to the scripting API same-origin, Zod-parsed, with no scope argument, and imports no test support', () => {
    const clients = scriptingClients();
    expect(clients.length, 'no apps/web/lib module talks to /api/v1/scripts').toBeGreaterThan(0);
    for (const { file, source } of clients) {
      const code = withoutComments(source);
      expect(code, `${file} names an absolute API origin`).not.toMatch(/https?:\/\/[^'"`]*\/api\/v1/);
      expect(code, `${file} does not parse with Zod`).toMatch(/from ['"]zod['"]/);
      expect(code, `${file} builds a scope argument`).not.toMatch(/programmeIds|(set|append)\(\s*['"`]programme|['"`]x-[\w-]*(programme|tenant)/i);
    }
    for (const { file, source } of webSources()) {
      expect(withoutComments(source), `${file} imports test support`).not.toMatch(
        /from ['"][^'"]*(tests\/e2e|scripting-mock|contact-record-mock|@kasuwa\/testing)[^'"]*['"]/,
      );
    }
  });
});

// ===========================================================================
// 2. i18n
// ===========================================================================

describe('acceptance: T-0115 — every string through i18n, in every catalogue, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the editor route file', () => {
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(
      /files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/,
    );
    const page = routePage(EDITOR_ROUTE);
    expect(page, 'there is no apps/web/app/**/scripts/[scriptId]/page.tsx').toBeDefined();
    const planted = eslint(
      ['--stdin', '--stdin-filename', page ?? 'apps/web/app/scripts/[scriptId]/page.tsx', '--format', 'json'],
      'export default function Planted() {\n  return <p>Publish v13</p>;\n}\n',
    );
    expect(planted.output, `a literal JSX string at ${page} is not rejected:\n${planted.output.slice(-2000)}`).toContain('i18next/no-literal-string');
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const slice = screenSlice();
    const run = eslint(['--max-warnings', '0', ...slice.map(({ file }) => file)]);
    expect(run.status, `eslint fails on the builder slice:\n${run.output.slice(-4000)}`).toBe(0);
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('puts every message the slice names, and a label for every node kind, operator, field type and publish reason, in every design-menu catalogue', async () => {
    const i18n: { DESIGN_MENU_LOCALES: readonly string[] } = await import(fromRoot('packages/i18n/src/index.ts'));
    const en = catalogue('en');
    const slice = screenSlice();
    const named = new Set<string>();
    for (const { source } of slice) {
      for (const match of withoutComments(source).matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)) {
        if (match[1] !== undefined && en[match[1]] !== undefined) named.add(match[1]);
      }
    }
    // Vacuity guard: a slice that names no catalogue key is not using i18n.
    expect(named.size, 'the builder slice names almost no message id').toBeGreaterThan(10);

    const find = (what: string, suffix: string): string => {
      const key = Object.keys(en).find((id) => id.endsWith(suffix));
      expect(key, `en.json has no label for ${what} (an id ending "${suffix}")`).toBeDefined();
      return key ?? `<missing ${what}>`;
    };
    const kinds = Object.keys((contract().components.schemas.ScriptNode?.discriminator as { mapping: Json }).mapping);
    expect(kinds, 'the contract lists no node kinds').toEqual(expect.arrayContaining(['say', 'question', 'form', 'branch', 'compliance', 'end']));
    const operators = enumAt('ConditionOperator', 'enum');
    expect(operators.length).toBeGreaterThan(3);
    const fieldTypes = enumAt('FormField', 'properties', 'type', 'enum');
    expect(fieldTypes).toEqual(expect.arrayContaining(['text', 'money', 'date', 'choice']));
    const prose = String(contract().paths['/api/v1/scripts/{scriptId}/versions']?.post?.description ?? '');
    for (const reason of PUBLISH_REASONS) {
      expect(prose, `publishScript no longer names ${reason}: update this list`).toContain(`\`${reason}\``);
    }
    const keys = [
      ...kinds.map((kind) => find(`the ${kind} node kind`, `.nodeType.${kind}`)),
      ...operators.map((operator) => find(`the ${operator} operator`, `.operator.${operator}`)),
      ...fieldTypes.map((type) => find(`the ${type} field type`, `.fieldType.${type}`)),
      ...PUBLISH_REASONS.map((reason) => find(`the ${reason} publish reason`, `.reason.${reason}`)),
    ];
    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const key of [...named, ...keys]) {
        if (typeof messages[key] !== 'string' || messages[key].trim() === '') missing.push(`${locale}: ${key}`);
      }
    }
    expect(missing, 'message ids the builder uses that a catalogue lacks').toEqual([]);
  });

  it('localises, as scripting.error.<code> in every design-menu catalogue, every error the authoring operations answer', async () => {
    const i18n: { DESIGN_MENU_LOCALES: readonly string[] } = await import(fromRoot('packages/i18n/src/index.ts'));
    const codes = new Set(OPERATIONS.flatMap(([path, method]) => errorCodes(path, method)));
    expect([...codes], 'the authoring operations declare no error codes').toEqual(
      expect.arrayContaining(['not_found', 'not_permitted', 'stale_write', 'validation_failed', 'script_invalid']),
    );
    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const code of codes) {
        if (typeof messages[`scripting.error.${code}`] !== 'string') missing.push(`${locale}: scripting.error.${code}`);
      }
    }
    expect(missing, 'error codes a user would see raw').toEqual([]);
  });

  it('drops no design-menu language from the menu (D-P1)', async () => {
    // Passes before the work starts: it guards against the work, not for it.
    const i18n: { DESIGN_MENU_LOCALES: readonly string[]; MENU_LOCALES: readonly string[] } = await import(fromRoot('packages/i18n/src/index.ts'));
    expect(i18n.DESIGN_MENU_LOCALES.length).toBeGreaterThan(1);
    expect(i18n.DESIGN_MENU_LOCALES.filter((locale) => !i18n.MENU_LOCALES.includes(locale)), 'these languages fell off the menu').toEqual([]);
  });
});

// ===========================================================================
// 3. Colour, and the device
// ===========================================================================

describe('acceptance: T-0115 — no colour literal and no device storage in the slice', () => {
  it('the colour detector catches what the lint rule misses', () => {
    for (const planted of ['className="text-[#c00] p-2"', "style={{ color: 'red' }}", 'className="bg-amber-100"', "const edge = 'rgb(200 0 0)';", 'className="border-black"']) {
      expect(colourLiterals(planted), `the detector missed ${planted}`).not.toEqual([]);
    }
    expect(colourLiterals('className="bg-surface text-text-2 border-border-strong bg-warning-soft"')).toEqual([]);
  });

  it('the slice reaches the screen through its imports, and stops at the shared shells', () => {
    const slice = screenSlice();
    const files = slice.map(({ file }) => file);
    expect(files).toContain(routePage(EDITOR_ROUTE) ?? '<no page>');
    expect(files.filter((file) => SHARED_SHELLS.some((shell) => file.startsWith(shell)))).toEqual([]);
    expect(files.length, 'the slice is the route files alone: nothing they import was followed').toBeGreaterThan(2);
  });

  it('writes no colour literal anywhere in the slice (the canvas edges included)', () => {
    const found = screenSlice().flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the builder slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('touches no device-storage API: a draft lives in memory only (D-P21)', () => {
    const storage = /\b(localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|navigator\.storage|document\.cookie)\b/;
    const found = screenSlice().filter(({ source }) => storage.test(withoutComments(source))).map(({ file }) => file);
    expect(found, 'the builder slice uses a device-storage API').toEqual([]);
  });
});

// ===========================================================================
// 4. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0115 — the journeys and the mock are the ones this suite was written with', () => {
  it('pins p10-builder.spec.ts and scripting-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(
        normalisedHash(file),
        `${file} changed. It is part of the T-0115 acceptance contract: ask the lead to re-pin it ` +
          '(only SCRIPT_BUILDER_BUDGET_BYTES may move without that).',
      ).toBe(pinned);
    }
    const mock = readFileSync(fromRoot(MOCK), 'utf8');
    expect(mock, 'the mock no longer reads the scripting contract').toContain(CONTRACT);
    expect(mock, 'the mock no longer checks its own answers against the contract').toMatch(/answerProblems\(operation, status, body\)/);
  });
});

// ===========================================================================
// 5. The tag is this screen's alone (D-L84)
// ===========================================================================

describe('acceptance: T-0115 — @p10-builder selects these journeys and nothing else', () => {
  it('no other spec carries a tag @p10-builder matches, ours matches no other parent tag, and the spec carries only ours', () => {
    // Passes once the spec exists: it guards later screens against colliding with this one.
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
// 6. The browser — one run of @p10-builder
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0115 e2e run did not start', outcomes: undefined, startedAt: 0 };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

function outcomes(): E2eOutcome[] {
  expect(e2eRun.outcomes, `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-6000)}`).toBeDefined();
  return e2eRun.outcomes ?? [];
}

describe('acceptance: T-0115 — the script builder in a browser', () => {
  beforeAll(() => {
    rmSync(OUTCOMES_FILE, { force: true });
    rmSync(fromRoot(BUDGET_RECORD), { force: true });
    const reporter = relative(fromRoot('tests', 'e2e'), fromRoot('tests', 'acceptance', 'support', 'e2e-outcomes-reporter.ts')).replace(/\\/g, '/');
    const startedAt = Date.now();
    const run = spawnSync(process.execPath, [fromRoot('tests', 'e2e', 'scripts', 'run-e2e.mjs'), '--grep', E2E_TAG, `--reporter=list,${reporter}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
      timeout: E2E_RUN_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
    });
    e2eRun = {
      status: run.status,
      output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error === undefined ? '' : `\n[spawn] ${run.error.message}`}`,
      outcomes: existsSync(OUTCOMES_FILE) ? (JSON.parse(readFileSync(OUTCOMES_FILE, 'utf8')) as E2eOutcome[]) : undefined,
      startedAt,
    };
  }, E2E_RUN_TIMEOUT_MS);

  it('runs every @p10-builder journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(journeys.length, 'the run reported fewer @p10-builder tests than there are behaviours').toBeGreaterThanOrEqual(REQUIRED.length);
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p10-builder tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter((outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag));
      expect(proving.length, `no PASSING @p10-builder test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('pins /scripts/[scriptId] at or under 260,000 bytes and within 5% of what this run measured', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'SCRIPT_BUILDER_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /scripts/[scriptId] budget is above its ceiling').toBeLessThanOrEqual(SCRIPT_BUILDER_BUDGET_CEILING);
    expect(budget).toBeLessThan(PRD_CEILING_BYTES);
    const record = fromRoot(BUDGET_RECORD);
    expect(existsSync(record), 'the budget test wrote no measurement').toBe(true);
    expect(statSync(record).mtimeMs, 'the measurement is older than this run').toBeGreaterThanOrEqual(e2eRun.startedAt);
    const measured = (JSON.parse(readFileSync(record, 'utf8')) as { transferredBytes: number }).transferredBytes;
    expect(measured, 'the measurement is empty').toBeGreaterThan(0);
    expect(budget, `the budget is under the ${measured} bytes measured`).toBeGreaterThanOrEqual(measured);
    expect(budget, `the budget is more than 5% over the ${measured} bytes measured — re-pin SCRIPT_BUILDER_BUDGET_BYTES`).toBeLessThanOrEqual(
      Math.round(measured * BUDGET_HEADROOM),
    );
  });
});
