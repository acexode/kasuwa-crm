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
 * ACCEPTANCE — T-0116, the P10 agent script screen in manual mode, frames
 * P10/01 to P10/04 (Agent 11, Frontend & Design System). Decisions: D-L88,
 * D-L93, D-L104, D-L107, D-P31, D-L97, D-L102.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. The flag `crm_scripts` (T-0115's; this suite holds it too, so either
 *      task can land first): registered, default OFF, not production-ready.
 *      The route `apps/web/app/(group)/script-runs/[runId]/page.tsx` calls
 *      `notFound()` and is gated on it; the contact record's start control is
 *      gated on it ON THE SERVER (the record's page reads it and passes a
 *      boolean down); no client module names it. A web process in
 *      run-e2e.mjs carries it with `crm_records` and `crm_record_view`, and
 *      the stack file publishes it as `webScriptsUrl`.
 *   2. The browser reads and writes the run API (T-0114) same-origin,
 *      Zod-parsed, with no scope argument; no apps/web module imports test
 *      support.
 *   3. P10/01 to P10/04 against the contract mock, by e2e tag (section 6):
 *      start from the contact record, lazily, keyset paged, `{ scriptId,
 *      contactId }` and nothing else; resume (the idempotent 200); each node
 *      as the server sends it, variables filled in from what the screen holds
 *      and a placeholder for a withheld one; server-driven advance, nothing
 *      optimistic, a 409 re-read; compliance acknowledged in the language
 *      shown; the language switch from the pinned version; form answers on
 *      the run only (D-P31), money in minor units; a withheld or sensitive
 *      stop as a message, never a guess; a mandatory live disposition, paged,
 *      the suggestion pre-chosen, its note or callback required; the callback
 *      in UTC from the browser's zone; interrupted completion with the unread
 *      statements by name; refusals as translated alerts and re-reads; the
 *      exact repeat as success; the version banner; the generic not-found;
 *      loading; answers never on the device or in the console; offline writes
 *      nothing; hidden features; 360 px; en-XA; the byte budget.
 *   4. i18n: the literal-string rule fires on the route; every message id the
 *      slice names is in every design-menu catalogue, and so is a label for
 *      each stop reason and each completion outcome, and a
 *      `scripting.error.<code>` for every code the run operations answer.
 *   5. No colour literal, no device-storage API and no console or beacon call
 *      in the slice: answers are sensitive (D-L93) and are never logged.
 *
 * PINNED INTERFACES (the builder's side): the DOM hooks in the header of
 * `tests/e2e/p10-agent.spec.ts`; the route above; stop reasons labelled under
 * an id ending `.stopped.<reason>`, outcomes under `.outcome.<outcome>`.
 *
 * RULINGS BEYOND THE TASK FILE (for the lead; the suite is written to them)
 *
 *   R1. The run has its own route, `/script-runs/[runId]`, in the CRM shell:
 *       a reload resumes it from the server (getScriptRun), and the contact
 *       record stays T-0062's. The start control lives on the record.
 *   R2. The contact record reads nothing of scripting until the agent opens
 *       the start control (listContactScripts is lazy). It keeps T-0062's
 *       mock and budget honest and costs the record nothing on 256 kbps.
 *   R3. The screen never evaluates a branch and never draws a node the run
 *       has not entered. The mock's `branch: 'true'` sends a run down the side
 *       the visible contact data says it should not, so a client-side
 *       evaluation is caught.
 *   R4. At an `end` node or on a stopped run the completion offered is
 *       `completed`; anywhere else the only one offered is `interrupted`
 *       (`end-early`). `completed` mid-script is a violation in the mock,
 *       not merely a 409: offering it would hide unread compliance (D-L93).
 *   R5. The acknowledgement reports the locale the screen SHOWED. The
 *       language buttons are the pinned version's source and translated
 *       locales; switching makes no request.
 *   R6. Form inputs: a choice field is a `<select>` of its options, a date
 *       an `<input type=date>`, money typed in major units (what the agent
 *       reads aloud) and sent as minor units in a string with the field's
 *       currency. Answers are recorded only through recordScriptRunAnswers,
 *       before the advance that needs them.
 *   R7. A disposition_not_live 409 re-reads the disposition list; a
 *       stale_write 409 re-reads the run. Neither retries by itself.
 *   R8. A completion whose answer was lost is sent again exactly as it was
 *       (the same body, revision included), and its 200 is a success. Every
 *       other refusal is a translated alert that keeps the sheet.
 *   R9. The callback is typed as a local time (`datetime-local`) in the
 *       browser's zone and sent as UTC with a Z; calling hours, team queues
 *       and the SMS reminder are not drawn (D-L88).
 *   R10. The completed run is a read-only summary: the outcome, the
 *       disposition's label, the callback time, and the titles of the
 *       compliance nodes the server says were left unread.
 *   R11. Provisional budget: /script-runs/[runId] at or under 245,000 B,
 *       re-pinned within 5% of the first measurement.
 *
 * BUILDER'S CHOICES: the layout; how done steps are summarised; the copy;
 * whether an auto-branch line is drawn between steps (if it is, it is not a
 * card and has no controls); where the run client lives (a `lib/` module).
 *
 * THE SLICE. Every apps/web module the `/script-runs` route directory
 * imports, and every module that draws the start control (names
 * `start-script`), transitively by relative import, except the shared shells.
 * It must contain the P10/01 screen (a module naming `P10/01`).
 *
 * THE BROWSER HALF. `tests/e2e/p10-agent.spec.ts` and the shared
 * `tests/e2e/support/scripting-mock.ts` are PINNED by hash below.
 * SCRIPT_RUN_BUDGET_BYTES is the one line that may change without a re-pin,
 * and only downwards towards the measurement.
 *
 * ONE RUN, NO SHELL:
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p10-agent --reporter=list,<ours>
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const FLAG = 'crm_scripts';
const PROCESS_FLAGS = ['crm_scripts', 'crm_records', 'crm_record_view'];

const E2E_TAG = '@p10-agent';

const OTHER_PARENT_TAGS = ['@p01', '@p02', '@p04', '@p04-accounts', '@p05-contact', '@p05-account', '@leads-p04', '@p10-builder'];

const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p10-agent.spec.ts';
const MOCK = 'tests/e2e/support/scripting-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/p10-agent-budget.json';
const CONTRACT = 'docs/api/scripting.openapi.yaml';

const PINNED_SHA256: Readonly<Record<string, string>> = {
  [SPEC]: '1a0bdbcd7b46b3207b121dccccfd535592119f6b3fdc9a00c90d8b7c16088731',
  [MOCK]: '66f8d540ecfd755363f4bfa764e69dc52112000f50af88ce8c2f06e61470b6dc',
};

const SCRIPT_RUN_BUDGET_CEILING = 275_000; // D-L203: T-0145 measured, after removing the weight it could (no visual change)
const BUDGET_HEADROOM = 1.05;
const PRD_CEILING_BYTES = 300 * 1024;

/** The run operations the screen calls (T-0114). */
const OPERATIONS: readonly (readonly [path: string, method: string])[] = [
  ['/api/v1/contacts/{contactId}/scripts', 'get'],
  ['/api/v1/script-runs', 'post'],
  ['/api/v1/script-runs/{runId}', 'get'],
  ['/api/v1/script-runs/{runId}/script', 'get'],
  ['/api/v1/script-runs/{runId}/advance', 'post'],
  ['/api/v1/script-runs/{runId}/acknowledgements', 'post'],
  ['/api/v1/script-runs/{runId}/answers', 'patch'],
  ['/api/v1/script-runs/{runId}/dispositions', 'get'],
  ['/api/v1/script-runs/{runId}/complete', 'post'],
];

const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the mock's validators
  // and its run engine bite, so every afterEach "no violations" means something.
  ['@p10-agent-mock', 'the contract mock refuses what the contract refuses, runs the script on the server and checks its answers'],
  // Passes before the work starts (no route): a negative invariant, given meaning by flag-on.
  ['@p10-agent-flag-off', '/script-runs/<id> is a 404 with every flag at its default, and the browser cannot flip it'],
  ['@p10-agent-flag-on', '/script-runs/<id> renders the run with crm_scripts on'],
  ['@p10-agent-start', 'the record offers runnable scripts lazily, keyset paged, and starts one with { scriptId, contactId }'],
  ['@p10-agent-resume', 'starting again resumes the run in progress (200) at its current node'],
  ['@p10-agent-steps', 'the steps are the run’s path, the current node its currentNodeId; nothing not entered is drawn'],
  ['@p10-agent-variables', 'variables filled in from the contact and the agent; a withheld one is a placeholder'],
  ['@p10-agent-advance', 'advance sends the revision and the choice; the server picks the next node; nothing optimistic; a 409 re-reads'],
  ['@p10-agent-compliance', 'compliance acknowledged on the server, in the language shown, before the run moves on'],
  ['@p10-agent-language', 'the language switch uses the pinned translations with no request, and says when it falls back'],
  ['@p10-agent-form', 'form answers on the run only, minor units, translated field errors (D-P31)'],
  ['@p10-agent-stopped', 'a withheld or sensitive stop is a message, never a guess; a run can start stopped'],
  ['@p10-agent-disposition', 'a mandatory live disposition, paged, the suggestion pre-chosen, its note required; a completed summary'],
  ['@p10-agent-follow-up', 'a required callback typed in the browser’s zone and sent in UTC'],
  ['@p10-agent-interrupted', 'a call cut short completes as interrupted, the unread statement by name'],
  ['@p10-agent-refusals', 'refusals are translated alerts; a 409 re-reads before anything is sent again; 403 keeps the sheet'],
  ['@p10-agent-repeat', 'a lost completion is sent again exactly, and its 200 is a success'],
  ['@p10-agent-banner', 'a run on an older version says so; one on the latest does not'],
  ['@p10-agent-not-found', 'another agent’s run and no run are one not-found; a non-uuid is a real 404 that reads nothing'],
  ['@p10-agent-loading', 'skeleton; a failed read is not "not found"'],
  ['@p10-agent-device', 'answers never in device storage, the address bar, the title or the console'],
  ['@p10-agent-offline', 'offline: every write disabled, nothing queued'],
  ['@p10-agent-hidden', 'no call bar, wrap-up, agent state, AI, SMS, calling hours, team queue, record panel or loan data'],
  ['@p10-agent-mobile', '360 px: no sideways scroll, axe-clean'],
  ['@p10-agent-pseudo', 'en-XA renders pseudo text on the run'],
  ['@p10-agent-budget', '/script-runs/[runId] inside its byte budget on the production build'],
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

function routePage(pattern: RegExp): string | undefined {
  return trackedFiles('apps/web/app').find((file) => pattern.test(file));
}

const RUN_ROUTE = /^apps\/web\/app\/(?:\([\w-]+\)\/)*script-runs\/\[runId\]\/page\.tsx$/;
const CONTACT_ROUTE = /^apps\/web\/app\/(?:\([\w-]+\)\/)*contacts\/\[id\]\/page\.tsx$/;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SHARED_SHELLS = ['apps/web/components/auth/', 'apps/web/components/crm/', 'apps/web/components/admin/'];

/** The run route directory and every module drawing the start control, and what they import, minus the shells. */
function sliceSources(): SourceFile[] {
  const page = routePage(RUN_ROUTE);
  if (page === undefined) {
    return [];
  }
  const sources = new Map(webSources().map((entry) => [entry.file, entry.source]));
  const directory = posix.dirname(page);
  const starters = [...sources.entries()]
    .filter(([file, source]) => file.startsWith('apps/web/components/') && /start-script/.test(withoutComments(source)))
    .map(([file]) => file);
  const queue = [...[...sources.keys()].filter((file) => file.startsWith(`${directory}/`)), ...starters];
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
      if (target !== undefined && !seen.has(target)) queue.push(target);
    }
  }
  return [...seen].sort().map((file) => ({ file, source: sources.get(file) ?? '' }));
}

function screenSlice(): SourceFile[] {
  const slice = sliceSources();
  expect(routePage(RUN_ROUTE), 'there is no apps/web/app/**/script-runs/[runId]/page.tsx').toBeDefined();
  expect(
    slice.filter(({ source }) => withoutComments(source).includes('P10/01')).map(({ file }) => file),
    'the /script-runs route imports no P10/01 screen (data-screen="P10/01")',
  ).not.toEqual([]);
  expect(
    slice.filter(({ source }) => /start-script/.test(withoutComments(source))).map(({ file }) => file),
    'no module draws the start control (data-action="start-script")',
  ).not.toEqual([]);
  return slice;
}

function scriptingClients(): SourceFile[] {
  return webSources().filter(({ file, source }) => file.startsWith('apps/web/lib/') && /\/api\/v1\/script-runs|\/scripts\b/.test(withoutComments(source)) && /\/api\/v1\//.test(source));
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8')) as Record<string, string>;
}

const BUDGET_LITERAL = /const SCRIPT_RUN_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(BUDGET_LITERAL, 'const SCRIPT_RUN_BUDGET_BYTES = <budget>;');
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

/** A call that could carry an answer off the page: the console, a beacon, an analytics hook. */
function leaks(source: string): string[] {
  return withoutComments(source).match(/\bconsole\s*\.\s*\w+\s*\(|\bnavigator\s*\.\s*sendBeacon\b|\bgtag\s*\(|\bdataLayer\b/g) ?? [];
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
// 1. The flag, the route and the start control
// ===========================================================================

describe('acceptance: T-0116 — the run screen and the start control are gated on crm_scripts', () => {
  it('registers crm_scripts, not production-ready, and OFF by default', async () => {
    await initialiseFeatureFlags();
    expect(Object.keys(FLAGS), `${FLAG} is not declared in FLAGS`).toContain(FLAG);
    const definition = (FLAGS as Readonly<Record<string, { productionReady?: boolean; defaultValue?: boolean }>>)[FLAG];
    expect(definition?.defaultValue, `${FLAG} does not default off`).toBe(false);
    expect(definition?.productionReady, `${FLAG} is marked production-ready`).toBe(false);
    const value = await featureFlagClient().getBooleanValue(FLAG, true, toEvaluationContext({ tenantId: 'acceptance-probe' }));
    expect(value, `${FLAG} does not evaluate OFF by default`).toBe(false);
  });

  it('has a run route that calls notFound() and is gated on crm_scripts, read on the server only', () => {
    const page = routePage(RUN_ROUTE);
    expect(page, 'there is no apps/web/app/**/script-runs/[runId]/page.tsx').toBeDefined();
    const source = withoutComments(readFileSync(fromRoot(page ?? 'missing'), 'utf8'));
    expect(source, `${page} does not call notFound()`).toMatch(/\bnotFound\s*\(/);
    expect(source, `${page} imports nothing from lib/feature-flags`).toMatch(/from ['"][./]*lib\/feature-flags['"]/);
    expect(gatedOn(source, FLAG), `${page} is not gated on ${FLAG} (readers: ${readersOf(FLAG).join(', ') || 'none'})`).toBe(true);
    const clientEvaluators = webSources().filter(({ source: code }) => /^\s*['"]use client['"]/m.test(code) && code.includes(FLAG));
    expect(clientEvaluators.map(({ file }) => file), 'a client module names crm_scripts — flags are read on the server only').toEqual([]);
  });

  it('gates the contact record’s start control on crm_scripts on the server', () => {
    const page = routePage(CONTACT_ROUTE);
    expect(page, 'the contact record route (T-0062) is gone').toBeDefined();
    const source = withoutComments(readFileSync(fromRoot(page ?? 'missing'), 'utf8'));
    expect(gatedOn(source, FLAG), `${page} does not read ${FLAG}: the start control would show (and read) with the flag off`).toBe(true);
  });

  it('serves the journeys from a process carrying crm_scripts and the contact record’s flags, and leaves the default server flagless', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    const processes = [...runner.matchAll(/KASUWA_FEATURE_FLAGS_ON:\s*['"`]([^'"`]*)['"`]/g)].map((match) => (match[1] ?? '').split(/[,\s]+/));
    expect(processes.some((flags) => PROCESS_FLAGS.every((flag) => flags.includes(flag))), `no web process carries ${PROCESS_FLAGS.join(', ')}`).toBe(true);
    expect(runner, 'run-e2e.mjs does not publish webScriptsUrl').toContain('webScriptsUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*''/);
  });

  it('talks to the run API same-origin, Zod-parsed, with no scope argument, and imports no test support', () => {
    const clients = scriptingClients().filter(({ source }) => /\/api\/v1\/script-runs/.test(withoutComments(source)));
    expect(clients.length, 'no apps/web/lib module talks to /api/v1/script-runs').toBeGreaterThan(0);
    for (const { file, source } of clients) {
      const code = withoutComments(source);
      expect(code, `${file} names an absolute API origin`).not.toMatch(/https?:\/\/[^'"`]*\/api\/v1/);
      expect(code, `${file} does not parse with Zod`).toMatch(/from ['"]zod(?:\/mini)?['"]/);
      expect(code, `${file} builds a scope argument`).not.toMatch(/programmeIds|(set|append)\(\s*['"`]programme|['"`]x-[\w-]*(programme|tenant)/i);
    }
    for (const { file, source } of webSources()) {
      expect(withoutComments(source), `${file} imports test support`).not.toMatch(/from ['"][^'"]*(tests\/e2e|scripting-mock|contact-record-mock|@kasuwa\/testing)[^'"]*['"]/);
    }
  });
});

// ===========================================================================
// 2. i18n
// ===========================================================================

describe('acceptance: T-0116 — every string through i18n, in every catalogue, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the run route file', () => {
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(
      /files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/,
    );
    const page = routePage(RUN_ROUTE);
    expect(page, 'there is no apps/web/app/**/script-runs/[runId]/page.tsx').toBeDefined();
    const planted = eslint(
      ['--stdin', '--stdin-filename', page ?? 'apps/web/app/script-runs/[runId]/page.tsx', '--format', 'json'],
      'export default function Planted() {\n  return <p>I read this statement in full</p>;\n}\n',
    );
    expect(planted.output, `a literal JSX string at ${page} is not rejected:\n${planted.output.slice(-2000)}`).toContain('i18next/no-literal-string');
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const slice = screenSlice();
    const run = eslint(['--max-warnings', '0', ...slice.map(({ file }) => file)]);
    expect(run.status, `eslint fails on the run slice:\n${run.output.slice(-4000)}`).toBe(0);
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('puts every message the slice names, and a label for every stop reason and outcome, in every design-menu catalogue', async () => {
    const i18n: { DESIGN_MENU_LOCALES: readonly string[] } = await import(fromRoot('packages/i18n/src/index.ts'));
    const en = catalogue('en');
    const slice = screenSlice();
    const named = new Set<string>();
    for (const { source } of slice) {
      for (const match of withoutComments(source).matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)) {
        if (match[1] !== undefined && en[match[1]] !== undefined) named.add(match[1]);
      }
    }
    expect(named.size, 'the run slice names almost no message id').toBeGreaterThan(10);
    const find = (what: string, suffix: string): string => {
      const key = Object.keys(en).find((id) => id.endsWith(suffix));
      expect(key, `en.json has no label for ${what} (an id ending "${suffix}")`).toBeDefined();
      return key ?? `<missing ${what}>`;
    };
    const reasons = enumAt('ScriptRun', 'properties', 'stopReason', 'enum');
    expect(reasons).toEqual(expect.arrayContaining(['field_withheld', 'sensitive_field']));
    const outcomes = enumAt('CompleteScriptRunRequest', 'properties', 'outcome', 'enum');
    expect(outcomes).toEqual(['completed', 'interrupted']);
    const keys = [
      ...reasons.map((reason) => find(`the ${reason} stop`, `.stopped.${reason}`)),
      ...outcomes.map((outcome) => find(`the ${outcome} outcome`, `.outcome.${outcome}`)),
    ];
    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const key of [...named, ...keys]) {
        if (typeof messages[key] !== 'string' || messages[key].trim() === '') missing.push(`${locale}: ${key}`);
      }
    }
    expect(missing, 'message ids the run screen uses that a catalogue lacks').toEqual([]);
  });

  it('localises, as scripting.error.<code> in every design-menu catalogue, every error the run operations answer', async () => {
    const i18n: { DESIGN_MENU_LOCALES: readonly string[] } = await import(fromRoot('packages/i18n/src/index.ts'));
    const codes = new Set(OPERATIONS.flatMap(([path, method]) => errorCodes(path, method)));
    expect([...codes], 'the run operations declare no error codes').toEqual(
      expect.arrayContaining([
        'not_found',
        'not_permitted',
        'stale_write',
        'validation_failed',
        'run_completed',
        'run_stopped',
        'run_at_end',
        'compliance_unacknowledged',
        'answers_incomplete',
        'disposition_not_live',
        'disposition_requirements_unmet',
        'script_not_published',
      ]),
    );
    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const code of codes) {
        if (typeof messages[`scripting.error.${code}`] !== 'string') missing.push(`${locale}: scripting.error.${code}`);
      }
    }
    expect(missing, 'error codes an agent would see raw').toEqual([]);
  });

  it('drops no design-menu language from the menu (D-P1)', async () => {
    // Passes before the work starts: it guards against the work, not for it.
    const i18n: { DESIGN_MENU_LOCALES: readonly string[]; MENU_LOCALES: readonly string[] } = await import(fromRoot('packages/i18n/src/index.ts'));
    expect(i18n.DESIGN_MENU_LOCALES.length).toBeGreaterThan(1);
    expect(i18n.DESIGN_MENU_LOCALES.filter((locale) => !i18n.MENU_LOCALES.includes(locale)), 'these languages fell off the menu').toEqual([]);
  });
});

// ===========================================================================
// 3. Colour, the device and the logs
// ===========================================================================

describe('acceptance: T-0116 — no colour literal, no device storage and no log call in the slice', () => {
  it('the colour and leak detectors catch what they are for', () => {
    for (const planted of ['className="text-[#c00] p-2"', "style={{ color: 'red' }}", 'className="bg-green-500"', "const tick = 'hsl(120 50% 50%)';"]) {
      expect(colourLiterals(planted), `the colour detector missed ${planted}`).not.toEqual([]);
    }
    expect(colourLiterals('className="bg-success-soft text-success-text border-border"')).toEqual([]);
    for (const planted of ['console.log(values);', 'console .debug(run)', 'navigator.sendBeacon("/x", body)', 'window.dataLayer.push(x)']) {
      expect(leaks(planted), `the leak detector missed ${planted}`).not.toEqual([]);
    }
    expect(leaks('// console.log(values)\nconst x = 1;')).toEqual([]);
  });

  it('the slice reaches the screen and the start control through their imports, and stops at the shared shells', () => {
    const slice = screenSlice();
    const files = slice.map(({ file }) => file);
    expect(files).toContain(routePage(RUN_ROUTE) ?? '<no page>');
    expect(files.filter((file) => SHARED_SHELLS.some((shell) => file.startsWith(shell)))).toEqual([]);
    expect(files.length, 'the slice is the route file alone: nothing it imports was followed').toBeGreaterThan(2);
  });

  it('writes no colour literal anywhere in the slice', () => {
    const found = screenSlice().flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the run slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('touches no device-storage API: a run and its answers live in memory only (D-L93, D-P21)', () => {
    const storage = /\b(localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|navigator\.storage|document\.cookie)\b/;
    const found = screenSlice().filter(({ source }) => storage.test(withoutComments(source))).map(({ file }) => file);
    expect(found, 'the run slice uses a device-storage API').toEqual([]);
  });

  it('logs nothing and sends nothing elsewhere: answers are sensitive and never logged (D-L93)', () => {
    const found = screenSlice().flatMap(({ file, source }) => leaks(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'the run slice can carry an answer to the console, a beacon or an analytics hook').toEqual([]);
  });
});

// ===========================================================================
// 4. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0116 — the journeys and the mock are the ones this suite was written with', () => {
  it('pins p10-agent.spec.ts and scripting-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(
        normalisedHash(file),
        `${file} changed. It is part of the T-0116 acceptance contract: ask the lead to re-pin it ` +
          '(only SCRIPT_RUN_BUDGET_BYTES may move without that).',
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

describe('acceptance: T-0116 — @p10-agent selects these journeys and nothing else', () => {
  it('no other spec carries a tag @p10-agent matches, ours matches no other parent tag, and the spec carries only ours', () => {
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
// 6. The browser — one run of @p10-agent
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0116 e2e run did not start', outcomes: undefined, startedAt: 0 };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

function outcomes(): E2eOutcome[] {
  expect(e2eRun.outcomes, `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-6000)}`).toBeDefined();
  return e2eRun.outcomes ?? [];
}

describe('acceptance: T-0116 — the agent script screen in a browser', () => {
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

  it('runs every @p10-agent journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    expect(journeys.length, 'the run reported fewer @p10-agent tests than there are behaviours').toBeGreaterThanOrEqual(REQUIRED.length);
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p10-agent tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter((outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag));
      expect(proving.length, `no PASSING @p10-agent test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('pins /script-runs/[runId] at or under 245,000 bytes and within 5% of what this run measured', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'SCRIPT_RUN_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /script-runs/[runId] budget is above its ceiling').toBeLessThanOrEqual(SCRIPT_RUN_BUDGET_CEILING);
    expect(budget).toBeLessThan(PRD_CEILING_BYTES);
    const record = fromRoot(BUDGET_RECORD);
    expect(existsSync(record), 'the budget test wrote no measurement').toBe(true);
    expect(statSync(record).mtimeMs, 'the measurement is older than this run').toBeGreaterThanOrEqual(e2eRun.startedAt);
    const measured = (JSON.parse(readFileSync(record, 'utf8')) as { transferredBytes: number }).transferredBytes;
    expect(measured, 'the measurement is empty').toBeGreaterThan(0);
    expect(budget, `the budget is under the ${measured} bytes measured`).toBeGreaterThanOrEqual(measured);
    expect(budget, `the budget is more than 5% over the ${measured} bytes measured — re-pin SCRIPT_RUN_BUDGET_BYTES`).toBeLessThanOrEqual(
      Math.round(measured * BUDGET_HEADROOM),
    );
  });
});
