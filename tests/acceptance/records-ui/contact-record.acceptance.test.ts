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
 * ACCEPTANCE — T-0062, the P05 contact record, the 360° view (Agent 11,
 * Frontend & Design System). Decisions: D-L64, D-L69, D-L72, D-L73, D-L81,
 * D-L84, D-P1, D-P14, D-P18, D-P21, D-P23.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. `crm_record_view`: a registered flag, DEFAULT OFF, NOT production-ready,
 *      read on the server through `lib/feature-flags.ts`. The `/contacts/[id]`
 *      page calls `notFound()` and is gated on it: with every flag at its
 *      default the route is a real 404. `crm_records` alone (today's
 *      scaffolding gate) does not satisfy section 1.
 *   2. The e2e harness publishes `webRecordViewUrl`: the SAME production
 *      build, `crm_record_view` in KASUWA_FEATURE_FLAGS_ON (NODE_ENV=test,
 *      as D-L64 ruled). The default server stays flagless.
 *   3. The browser reads the record and its timeline, and writes activities,
 *      same-origin (`/api/v1/contacts/{id}`, `…/timeline`,
 *      `/api/v1/activities`), Zod-parsed, with no scope argument.
 *   4. P05/01, 02, 05 and 06 against the contract mock — details by field
 *      security, the account summary, the timeline (values only where served,
 *      actors by name, "System" for null, keyset "load older"), inline status
 *      and assign-to-me (D-P14/D-P18), the full edit, logging and completing
 *      activities, refusals as translated alerts, the generic not-found for an
 *      out-of-scope id, loading, offline in memory only, the hidden features,
 *      no UUID printed, 360 px, en-XA and the byte budget — by e2e tag
 *      (section 6).
 *   5. i18n: the literal-string rule fires on the route; every message id the
 *      slice names is in every design-menu catalogue; a label for every
 *      activity type and every timeline field; no language falls off the menu.
 *   6. No colour literal (wider than the lint rule) and no device-storage API
 *      in the slice.
 *
 * PINNED INTERFACES (the builder's side): the DOM hooks, the
 * `webRecordViewUrl` stack key and the other interfaces listed in the header
 * of `tests/e2e/p05-contact.spec.ts`; the route file
 * `apps/web/app/(group)/contacts/[id]/page.tsx`; activity-type labels under a
 * message id containing `activit` and ending `.type.<code>`; timeline field
 * labels under an id ending `.field.<name>` or `.col.<name>` (T-0042's
 * `records.col.*` count).
 *
 * BUILDER'S CHOICES: a new Next process or `crm_record_view` on an existing
 * one (every link on the page must still resolve there); the layout (three
 * columns, tabs on mobile, as P05/02 shows, or simpler); a status menu or a
 * native select; one "log" menu or three buttons; whether the account summary
 * links anywhere (it may not link to a 404, so not to `/accounts/[id]` until
 * T-0063 serves it on the same process); whether the programme is shown (if it
 * is, by name); where the record client lives; the copy.
 *
 * THE SLICE. Every apps/web module the `/contacts/[id]` route directory
 * imports, transitively by relative import, except the shared shells
 * (`components/auth`, `components/crm`, `components/admin`), which T-0007,
 * T-0042 and the P02 suites already hold and which carry the language menu's
 * own locale cookie. It must contain the P05 screen (a module naming
 * `P05/01`), so the scaffolding that is there today does not count.
 *
 * NOT HELD HERE, AND WHY
 *   - Completing a task the screen only saw on the timeline. `updateActivity`
 *     requires `version` and nothing serves it (`ActivityItem` has none; there
 *     is no getActivity). The spec carries it as a `fixme`
 *     (`@p05-contact-complete-served`) and REQUIRED omits it. Completing a
 *     task the screen logged (its version from the 201) IS required. This is a
 *     contract gap for the lead.
 *   - "Non-writers see no write controls": D-L84, the same capability-read gap
 *     as T-0057. Write controls show to every caller; the refusals are held.
 *
 * THE BROWSER HALF. `tests/e2e/p05-contact.spec.ts` (journeys) and
 * `tests/e2e/support/contact-record-mock.ts` (the contract mock) were written
 * with this suite and are PINNED by hash below, because `tests/e2e` is not
 * path-protected (D-L64). CONTACT_RECORD_BUDGET_BYTES is the one line the
 * builder may change, and only downwards towards the measurement (section 6).
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p05-contact --reporter=list,<ours>
 *
 * spawned with `shell: false` and the arguments as an array: one tag, no shell
 * metacharacter (D-L62). Every test is read from the outcomes file our
 * reporter writes, so a skipped, `fixme`d or unmatched test never counts.
 * `--grep @p04` (T-0042, T-0057) does not match `@p05-contact`, and no other
 * spec's tag starts with it (section 5 checks both, D-L84).
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const FLAG = 'crm_record_view';

const E2E_TAG = '@p05-contact';

/** `next build` (SWC wasm on the dev host, D-L62), a container, the servers and the journeys. */
const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p05-contact.spec.ts';
const MOCK = 'tests/e2e/support/contact-record-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/p05-contact-budget.json';
const CONTRACT = 'docs/api/records.openapi.yaml';

/**
 * The pinned browser half (CRLF folded to LF; the budget literal normalised).
 * A change to either file is a change to the acceptance contract: the lead
 * re-pins it, the builder does not.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  [SPEC]: '764fe62ac2db767c8b59f1a614d7f870dec872df9c712b2d6f4fba106a510ba4',
  // T-0080: the mock's activity items carry `version`, as the contract now requires.
  // T-0082 (D-L97): the mock's activity items and bodies carry `startsAt` and `endsAt`.
  // T-0091 (lead re-pin): the mock answers listCustomFields (empty unless a journey sets custom fields) and merges `custom`.
  [MOCK]: 'f1d564c4c40f9a8f7c6da7ceeaac8b4b0c6841d30f837433a9d1f8267955e2ce',
};

/** See the budget test in the spec for the derivation. Never above this. */
const CONTACT_RECORD_BUDGET_CEILING = 245_000;

/** Re-pinned within 5% of what the run measured, like /contacts (T-0042) and P01/1 (T-0035). */
const BUDGET_HEADROOM = 1.05;

const PRD_CEILING_BYTES = 300 * 1024;

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the mock's validators
  // reject malformed requests, so every afterEach "no violations" means something.
  ['@p05-contact-mock', 'the contract mock refuses what the contract refuses'],
  ['@p05-contact-flag-off', '/contacts/[id] is a 404 with every flag at its default, and the browser cannot flip it'],
  ['@p05-contact-flag-on', '/contacts/[id] renders the record with crm_record_view on'],
  ['@p05-contact-shell', 'the CRM shell, no link on the page a 404'],
  ['@p05-contact-details', 'fields as values and labels, never codes or ids; markup as text; no name in the title; axe-clean'],
  ['@p05-contact-locked', 'a withheld field is a lock, never blank, never editable; a null is never a lock'],
  ['@p05-contact-account', 'the account summary by name, no 404 link, locked with accountId'],
  ['@p05-contact-timeline', 'every item once in served order; actors by name, "System" for null; values only where served'],
  ['@p05-contact-paging', 'keyset "load older", the cursor echoed and never in the URL, no total'],
  ['@p05-contact-inline-status', 'the inline status edit sends version and status only'],
  ['@p05-contact-assign-me', 'assign to me sends version and the session user id only'],
  ['@p05-contact-edit', 'the full edit sends only what changed and no withheld field'],
  ['@p05-contact-refusals', '403 and 409 on contact writes are translated alerts; nothing optimistic is left behind'],
  ['@p05-contact-log', 'a note, a task and a call are logged once, with contract bodies, due times in UTC'],
  ['@p05-contact-complete', 'a logged task is completed with the version it was served'],
  ['@p05-contact-activity-refusals', 'a refused activity is a translated alert, the form kept, nothing added'],
  ['@p05-contact-not-found', 'out of scope, missing and malformed ids are the generic not-found, never "access denied"'],
  ['@p05-contact-loading', 'P05/06 skeleton; a failed read is not "not found"; a failed timeline is not "no history"'],
  ['@p05-contact-offline', 'offline: memory only, last synced, every write disabled'],
  ['@p05-contact-hidden', 'no WhatsApp composer, AI summary, recording, NIN, addresses or Follow'],
  ['@p05-contact-mobile', '360 px: no sideways scroll, axe-clean'],
  ['@p05-contact-pseudo', 'en-XA renders pseudo text on the record'],
  ['@p05-contact-budget', '/contacts/[id] inside its byte budget on the production build'],
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

/** The App Router page for `/contacts/[id]` (a route group such as `(crm)` allowed). */
function recordPage(): string | undefined {
  return trackedFiles('apps/web/app').find((file) =>
    /^apps\/web\/app\/(?:\([\w-]+\)\/)*contacts\/\[id\]\/page\.tsx$/.test(file),
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

/** The slice, refused unless it contains the P05 screen itself. */
function screenSlice(): SourceFile[] {
  const slice = sliceSources();
  expect(recordPage(), 'there is no apps/web/app/**/contacts/[id]/page.tsx').toBeDefined();
  expect(
    slice.filter(({ source }) => withoutComments(source).includes('P05/01')).map(({ file }) => file),
    'the /contacts/[id] route imports no P05/01 screen (data-screen="P05/01")',
  ).not.toEqual([]);
  return slice;
}

/** apps/web/lib modules that read the timeline or write activities. */
function recordClients(): SourceFile[] {
  return webSources().filter(
    ({ file, source }) =>
      file.startsWith('apps/web/lib/') &&
      /\/timeline\b|\/api\/v1\/activities/.test(withoutComments(source)),
  );
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8'),
  ) as Record<string, string>;
}

const BUDGET_LITERAL = /const CONTACT_RECORD_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(BUDGET_LITERAL, 'const CONTACT_RECORD_BUDGET_BYTES = <budget>;');
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

// ===========================================================================
// 1. The flag and the route
// ===========================================================================

describe('acceptance: T-0062 — crm_record_view exists, is off, is not production-ready, and gates /contacts/[id]', () => {
  it('registers crm_record_view, not production-ready, and it evaluates OFF by default', async () => {
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

  it('is read through lib/feature-flags.ts and never by a client module; /contacts/[id] calls notFound() on crm_record_view', () => {
    const flagModule = withoutComments(readFileSync(fromRoot('apps/web/lib/feature-flags.ts'), 'utf8'));
    const named = new RegExp(`['"]${FLAG}['"]`);
    const clientEvaluators = webSources().filter(
      ({ source }) => /^\s*['"]use client['"]/m.test(source) && source.includes(FLAG),
    );
    expect(
      clientEvaluators.map(({ file }) => file),
      'a client module names crm_record_view — flags are read on the server only',
    ).toEqual([]);

    // The exported readers whose body evaluates crm_record_view by name.
    const readers = [...flagModule.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)]
      .filter((match) => named.test(match[2] ?? ''))
      .map((match) => match[1] ?? '');

    const page = recordPage();
    expect(page, 'there is no apps/web/app/**/contacts/[id]/page.tsx').toBeDefined();
    const source = withoutComments(readFileSync(fromRoot(page ?? 'missing'), 'utf8'));
    expect(source, `${page} does not call notFound()`).toMatch(/\bnotFound\s*\(/);
    expect(source, `${page} imports nothing from lib/feature-flags`).toMatch(/from ['"][./]*lib\/feature-flags['"]/);
    // Its OWN flag: a dedicated reader, or a generic one called with the name;
    // never crm_records alone, which is today's scaffolding gate.
    const gated = readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source)) || named.test(source);
    expect(gated, `${page} is not gated on crm_record_view (readers found: ${readers.join(', ') || 'none'})`).toBe(true);
  });

  it('starts a crm_record_view web process, publishes webRecordViewUrl, and leaves the default server flagless', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    expect(runner, 'run-e2e.mjs starts no web process with crm_record_view in KASUWA_FEATURE_FLAGS_ON').toMatch(
      /KASUWA_FEATURE_FLAGS_ON:\s*['"`][^'"`]*\bcrm_record_view\b/,
    );
    expect(runner, 'run-e2e.mjs does not publish webRecordViewUrl in the stack file').toContain('webRecordViewUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(
      /KASUWA_FEATURE_FLAGS_ON:\s*''/,
    );
  });

  it('reads the timeline and writes activities same-origin, Zod-parsed, with no scope argument', () => {
    const clients = recordClients();
    const code = (file: string) => withoutComments(clients.find((entry) => entry.file === file)?.source ?? '');
    expect(
      clients.filter(({ source }) => /\/timeline\b/.test(withoutComments(source))).map(({ file }) => file),
      'no apps/web/lib module reads /api/v1/contacts/{id}/timeline',
    ).not.toEqual([]);
    expect(
      clients.filter(({ source }) => withoutComments(source).includes('/api/v1/activities')).map(({ file }) => file),
      'no apps/web/lib module writes /api/v1/activities',
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
        /from ['"][^'"]*(tests\/e2e|contact-record-mock|records-mock|@kasuwa\/testing)[^'"]*['"]/,
      );
    }
  });
});

// ===========================================================================
// 2. i18n — the lint rule, every catalogue, D-P1
// ===========================================================================

describe('acceptance: T-0062 — every string through i18n, in every catalogue, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the /contacts/[id] route file', () => {
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(
      /files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/,
    );
    // A rule only ever seen passing proves nothing. Plant a literal at the
    // route's own path and watch it fail.
    const page = recordPage();
    expect(page, 'there is no apps/web/app/**/contacts/[id]/page.tsx').toBeDefined();
    const planted = eslint(
      ['--stdin', '--stdin-filename', page ?? 'apps/web/app/contacts/[id]/page.tsx', '--format', 'json'],
      'export default function Planted() {\n  return <p>Load older activity</p>;\n}\n',
    );
    expect(planted.output, `a literal JSX string at ${page} is not rejected:\n${planted.output.slice(-2000)}`).toContain(
      'i18next/no-literal-string',
    );
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const slice = screenSlice();
    const run = eslint(['--max-warnings', '0', ...slice.map(({ file }) => file)]);
    expect(run.status, `eslint fails on the contact record slice:\n${run.output.slice(-4000)}`).toBe(0);

    // jsx-text-only cannot see attributes; an English aria-label is still English.
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('puts every message the slice names, a label for each activity type and each timeline field, in every design-menu catalogue', async () => {
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
    expect(named.size, 'the contact record slice names almost no message id').toBeGreaterThan(10);

    const activityTypes = enumAt('ActivityType', 'enum');
    expect(activityTypes, 'the contract lists no activity types').toEqual(expect.arrayContaining(['note', 'task', 'call']));
    const typeKeys = activityTypes.map((type) => {
      const key = Object.keys(en).find((id) => /activit/i.test(id) && id.endsWith(`.type.${type}`));
      expect(key, `en.json has no label for the ${type} activity type (an id containing "activit", ending ".type.${type}")`).toBeDefined();
      return key ?? `<missing>.type.${type}`;
    });

    const timelineFields = [
      ...enumAt('FieldChangeWithValues', 'properties', 'field', 'enum'),
      ...enumAt('FieldChangeRedacted', 'properties', 'field', 'enum'),
    ];
    expect(timelineFields.length, 'the contract lists no timeline fields').toBeGreaterThan(10);
    const fieldKeys = timelineFields.map((name) => {
      const key = Object.keys(en).find((id) => id.endsWith(`.field.${name}`) || id.endsWith(`.col.${name}`));
      expect(key, `en.json has no label for the timeline field ${name} (an id ending ".field.${name}" or ".col.${name}")`).toBeDefined();
      return key ?? `<missing>.field.${name}`;
    });

    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const key of [...named, ...typeKeys, ...fieldKeys]) {
        if (typeof messages[key] !== 'string' || messages[key].trim() === '') {
          missing.push(`${locale}: ${key}`);
        }
      }
    }
    expect(missing, 'message ids the contact record uses that a catalogue lacks').toEqual([]);
  });

  it('localises every error the record operations can answer with', () => {
    // NOTE: passes before the work starts — T-0042 already added records.error.*
    // for every shared code. It is here so a new code in the contract (or a
    // dropped key) fails this suite rather than reaching a user as a raw code.
    const en = catalogue('en');
    const codes = new Set([
      ...errorCodes('/api/v1/contacts/{contactId}', 'get'),
      ...errorCodes('/api/v1/contacts/{contactId}', 'patch'),
      ...errorCodes('/api/v1/contacts/{contactId}/timeline', 'get'),
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

describe('acceptance: T-0062 — no colour literal and no device storage in the slice', () => {
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
    expect(files).toContain(recordPage() ?? '<no page>');
    expect(files.filter((file) => SHARED_SHELLS.some((shell) => file.startsWith(shell)))).toEqual([]);
    expect(files.length, 'the slice is the route file alone: nothing it imports was followed').toBeGreaterThan(1);
  });

  it('writes no colour literal anywhere in the slice', () => {
    const found = screenSlice().flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the contact record slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('touches no device-storage API (D-L64, D-P21)', () => {
    const storage = /\b(localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|navigator\.storage|document\.cookie)\b/;
    const found = screenSlice().filter(({ source }) => storage.test(withoutComments(source))).map(({ file }) => file);
    expect(found, 'the contact record slice uses a device-storage API: the record lives in memory only').toEqual([]);
  });
});

// ===========================================================================
// 4. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0062 — the journeys and the mock are the ones this suite was written with', () => {
  it('pins p05-contact.spec.ts and contact-record-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(
        normalisedHash(file),
        `${file} changed. It is part of the T-0062 acceptance contract: ask the lead to re-pin it ` +
          '(only CONTACT_RECORD_BUDGET_BYTES may move without that).',
      ).toBe(pinned);
    }
    expect(readFileSync(fromRoot(MOCK), 'utf8'), 'the mock no longer reads the records contract').toContain(CONTRACT);
  });
});

// ===========================================================================
// 5. The tag is this screen's alone (D-L84)
// ===========================================================================

describe('acceptance: T-0062 — @p05-contact selects these journeys and nothing else', () => {
  it('no other spec carries a tag that @p05-contact matches, and the spec carries only @p05-contact tags', () => {
    // Passes before the work starts: it guards later screens against
    // colliding with this one, as `@p04` once collided with `@p04-accounts`.
    const specs = trackedFiles('tests/e2e').filter((file) => file.endsWith('.spec.ts') && existsSync(fromRoot(file)));
    expect(specs).toContain(SPEC);
    // Code only: a header comment may name another screen's tag to say it is clear.
    const tagsIn = (file: string) =>
      [...withoutComments(readFileSync(fromRoot(file), 'utf8')).matchAll(/@[a-z0-9][\w-]*/gi)].map((match) => match[0]);
    const ours = tagsIn(SPEC).filter((tag) => /^@p\d/.test(tag));
    expect(ours.length).toBeGreaterThan(REQUIRED.length);
    expect(ours.filter((tag) => !tag.startsWith(E2E_TAG)), 'the spec carries another screen’s tag').toEqual([]);
    const clashes = specs
      .filter((file) => file !== SPEC)
      .flatMap((file) => tagsIn(file).filter((tag) => tag.includes(E2E_TAG)).map((tag) => `${file}: ${tag}`));
    expect(clashes, `--grep ${E2E_TAG} would also run these`).toEqual([]);
    // And the screens before it do not select it.
    expect(new RegExp('@p04').test(E2E_TAG), '--grep @p04 runs this screen').toBe(false);
  });
});

// ===========================================================================
// 6. The browser — one run of @p05-contact
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0062 e2e run did not start', outcomes: undefined, startedAt: 0 };

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

describe('acceptance: T-0062 — the contact record in a browser', () => {
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

  it('runs every @p05-contact journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(journeys.length, 'the run reported fewer @p05-contact tests than there are behaviours').toBeGreaterThanOrEqual(
      REQUIRED.length,
    );
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p05-contact tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter(
        (outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag),
      );
      expect(proving.length, `no PASSING @p05-contact test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('pins /contacts/[id] at or under 245,000 bytes and within 5% of what this run measured', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'CONTACT_RECORD_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /contacts/[id] budget is above its ceiling').toBeLessThanOrEqual(CONTACT_RECORD_BUDGET_CEILING);
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
      `the budget is more than 5% over the ${measured} bytes measured — re-pin CONTACT_RECORD_BUDGET_BYTES`,
    ).toBeLessThanOrEqual(Math.round(measured * BUDGET_HEADROOM));
  });
});
