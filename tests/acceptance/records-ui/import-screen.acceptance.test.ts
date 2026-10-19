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
 * ACCEPTANCE — T-0096, the P28 import wizard (Agent 11, Frontend & Design
 * System), against T-0093's contract (tag `imports`) on mocks; the real API
 * is T-0094's. Decisions: ADR-0017, D-L128 (Q4, Q6, Q7), D-L146, D-L148,
 * D-L150, D-L151, D-L159, D-L160, D-P12, D-P21, D-P28, D-L84, D-L64.
 * Written by the lead's QA agent before the screen exists (D-L23).
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. `crm_import`: registered, DEFAULT OFF, NOT production-ready, read on
 *      the server through `lib/feature-flags.ts`. `/contacts/import`
 *      (`apps/web/app/contacts/import/page.tsx`) calls `notFound()` and is
 *      gated on it by name, so with every flag at its default it is a real
 *      404. No client module names it. `crmLiveNav()` lists `import` exactly
 *      when it is on, and every module that links `/contacts/import` (the
 *      Contacts list's import action) decides by `live.includes('import')`,
 *      so with the flag off there is no link.
 *   2. The harness: the builder adds `crm_import` to the RECORDS web process
 *      and publishes `webImportUrl` in the change that registers the flag
 *      (naming an unregistered flag stops that process booting, so this suite
 *      cannot, as T-0087's R3). Every older records-ui suite then runs with it
 *      on: their journeys and pinned byte budgets must still pass (the
 *      Contacts list gains a link and nothing else).
 *   3. A client in `apps/web/lib/` calls `/api/v1/imports` same-origin,
 *      Zod-parsed, with no scope argument. The browser PUTs parts only to the
 *      URLs the API issued: no web module names a storage host, an S3 SDK or
 *      the storage adapter.
 *   4. The screen against the contract mock, by e2e tag (section 6; hooks and
 *      rules in the header of `tests/e2e/p28-import.spec.ts`).
 *   5. i18n: the literal-string rule fires on the route; every message id
 *      the slice names is in every design-menu catalogue; a label for every
 *      row-error code, every refusal the screen draws, every status, and the
 *      fixed sentences (duplicate rule, restrict-only, D-L151's result note,
 *      the whole-row label, the A1 advice, the erased label, the truncation
 *      note); `records.error.<code>` for every error the nine operations
 *      answer, `import_status_conflict` and `upload_mismatch` included
 *      (D-L150).
 *   6. No colour literal, no device storage, no client-side read of the file
 *      (no parser, no FileReader, no worker) and no CSV or spreadsheet
 *      library in the slice or in apps/web's dependencies.
 *
 * RULINGS (the suite is written to these; the lead accepts or amends them)
 *
 *   I1. Flag and route. `crm_import`; `/contacts/import` on the CRM shell,
 *       the history on the same page. The Contacts list's existing import
 *       action (`[data-action^="import"]`, P04) becomes the link where the
 *       flag is live; it keeps `data-requires-connection` (p04-contacts holds
 *       it disabled offline).
 *   I2. Steps. Four, `upload`, `mapping`, `phones`, `run` (A, A2–A3, A4,
 *       A5–A6): the design's "Review" step was a dry run, which D-L128 Q6
 *       removes. A labelled list with `aria-current="step"`.
 *   I3. Upload. The target is one of the session's programmes
 *       (listMyProgrammes), contacts only. Choosing a file starts the upload.
 *       The published `x-kasuwa-import-limits.maxFileBytes` is the limit: a
 *       larger file is refused BEFORE createImport, with the limit and advice
 *       (A1); "split it for me" and "migrate instead" are not built. Parts go
 *       straight to the issued URLs, at most TWO in flight, each PUT carrying
 *       nothing of the session; pause stops new parts and resume continues
 *       the SAME upload; a failed part is retried a bounded number of times
 *       (at most 5 tries); a 403 expired URL is re-issued through
 *       issueImportUploadUrls for the parts still to upload; cancel is
 *       abortImportUpload. Complete once, every part ascending, with the
 *       store's ETags.
 *   I4. The device (D-P21). The page never reads the file's bytes in script
 *       (it slices and sends; no parse, no preview, so no PII is held in the
 *       page), and keeps nothing of it on the device. The design's "carries
 *       on even if you close the tab" is therefore not built: a reload starts
 *       the upload over.
 *   I5. Mapping. Prefilled from `suggestedMapping`; one native select per
 *       header offering every ImportField the caller may edit, translated,
 *       and "do not import". The checklist's only item is the contract's
 *       required `displayName` (met by displayName, givenNames or
 *       familyName); the design's "Last name" and "Phone or email" are
 *       overruled. A repeated non-repeatable field never runs. Reuse sends
 *       `fromImportId` and shows the returned mapping; an import whose
 *       headers are erased is not offered. After `403 field_not_editable` the
 *       field is offered no more and never sent again (D-L84, as T-0091's C4).
 *       A refused mapping returns the screen to the mapping step.
 *   I6. Compliance (D-P28, D-L148). While `dnd`, `whatsappOptIn` or
 *       `consentState` is mapped, a restrict-only note says the import can
 *       only restrict (most restrictive wins, never "most recent").
 *   I7. A4. The default country is exactly NG, GH, KE and ZA, translated
 *       names; the duplicate rule is a sentence ("exact phone or email in
 *       this programme is skipped"), with no choice, no name-plus-date-of-
 *       birth rule (D-P12) and no preview of file values.
 *   I8. Run. Saves the mapping and runs once; polls getImport with a growing
 *       interval (no gap under 400 ms or over 20 s, and the interval grows);
 *       live counts in a polite live region; cancel while queued or running;
 *       polling stops when the job ends; a dropped poll is retried.
 *   I9. Report. Counts and `{ row, column, code }` rows only: the row number,
 *       the header's name (or, with the headers erased, the column's 1-based
 *       position or spreadsheet letter; a whole-row error a translated
 *       label), the translated code. D-L151's note. The truncation note. A
 *       link to `/contacts?importId=<id>`, and the Contacts list sends that
 *       `importId` on its read (else unfiltered rows look filtered, D-L75).
 *       No download of anything, no undo, no "updated" count (D-L128 Q6).
 *   I10. History and erasure (D-L148). Past imports as served, translated
 *       status, programme name, counts; an erased import has a neutral label
 *       and is never offered for reuse. Dates in `<time>`.
 *   I11. Budget. IMPORT_BUDGET_BYTES is a PROVISIONAL 250,000-byte
 *       placeholder under a 255,000 ceiling; the lead re-pins it within 5% of
 *       the builder's first green measurement (D-L118), and until then the
 *       budget check below fails by design, as T-0109's did.
 *
 * BUILDER'S CHOICES: the layout; the backoff numbers inside I8's bounds;
 * sequential or two-at-a-time parts; how a failed upload offers a retry;
 * whether reuse is offered across programmes; the copy; the slice's files.
 *
 * NOT HELD HERE, AND WHY
 *   - The live journey against T-0094's API on the third web server: the task
 *     file adds it once T-0094 merges; this suite runs on the mock only.
 *   - The storage origin in a CSP `connect-src`: there is no web CSP until
 *     ADR-0019's build (D-L150); T-0125 adds it.
 *   - A resumed upload after a reload or an `awaiting_mapping` job reopened
 *     by a non-creator: not asked for; the 403 is the gate (D-L151).
 *   - Notifications on completion: T-0101.
 *
 * THE BROWSER HALF. `tests/e2e/p28-import.spec.ts` (journeys) and
 * `tests/e2e/support/import-mock.ts` (the contract mock, which checks every
 * request and every answer against the YAML, and plays the object store) were
 * written with this suite and are PINNED by hash below, because `tests/e2e` is
 * not path-protected (D-L64). IMPORT_BUDGET_BYTES is the one line that may
 * change without a re-pin.
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p28-import --reporter=list,<ours>
 *
 * spawned with `shell: false` and the arguments as an array (D-L62). Every
 * test is read from the outcomes file our reporter writes, so a skipped,
 * `fixme`d or unmatched test never counts.
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const FLAG = 'crm_import';
/** The flags of the records process that `crm_import` rides on. */
const RECORDS_PROCESS_FLAGS = ['crm_records', 'crm_accounts', 'crm_record_view', 'crm_leads', 'crm_activities', 'crm_pipeline', 'crm_search', 'crm_custom_fields'];

const ROUTE = 'apps/web/app/contacts/import/page.tsx';
const ROUTE_DIRECTORY = 'apps/web/app/contacts/import/';
const SHELL_DIRECTORY = 'apps/web/components/crm/';
const CONTACTS_DIRECTORY = 'apps/web/components/contacts/';
const IMPORTS_PATH = '/api/v1/imports';

const E2E_TAG = '@p28-import';

/** `next build` (SWC wasm on the dev host, D-L62), a container, the servers and the journeys. */
const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p28-import.spec.ts';
const MOCK = 'tests/e2e/support/import-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/p28-import-budget.json';
const CONTRACT = 'docs/api/records.openapi.yaml';
const ADMIN_CONTRACT = 'docs/api/admin.openapi.yaml';

/**
 * The pinned browser half (CRLF folded to LF; the budget literal normalised).
 * A change to either file is a change to the acceptance contract: the lead
 * re-pins it, the builder does not.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  [SPEC]: '87f64b62aa10b42b6474ad6c59c4a9fc63ed05bbff97f00d1aeea5822ac41e0b',
  [MOCK]: '5f292a2fc9c209bb0de597c2ab274d4be44cf72da87a1b2a901f3212d2104e36',
};

/**
 * Never above this (I11). T-0125 lead re-pin (D-L189): the browser session's
 * required cost on every shell page (D-L187). The Mac final check on 01e4401
 * measured /contacts/import at 232,163 bytes against the 232,000 pin;
 * IMPORT_BUDGET_BYTES moved to 234,500, about 1.0% over, under this ceiling
 * and inside the 5% rule. The spec's hash ignores the budget literal, so it
 * is not re-pinned.
 */
const IMPORT_BUDGET_CEILING = 255_000;
const BUDGET_HEADROOM = 1.05;
const PRD_CEILING_BYTES = 300 * 1024;

const IMPORT_OPERATIONS: readonly (readonly [path: string, method: string])[] = [
  [IMPORTS_PATH, 'post'],
  [IMPORTS_PATH, 'get'],
  [`${IMPORTS_PATH}/{importId}`, 'get'],
  [`${IMPORTS_PATH}/{importId}/upload-urls`, 'post'],
  [`${IMPORTS_PATH}/{importId}/complete`, 'post'],
  [`${IMPORTS_PATH}/{importId}/abort`, 'post'],
  [`${IMPORTS_PATH}/{importId}/mapping`, 'put'],
  [`${IMPORTS_PATH}/{importId}/run`, 'post'],
  [`${IMPORTS_PATH}/{importId}/cancel`, 'post'],
];

/** The refusals the screen draws from a `details[].code` (I3, I5), each with an import error label. */
const REFUSAL_CODES = ['file_too_large', 'unsupported_type', 'mapping_incomplete', 'duplicate_mapping', 'unknown_reference', 'field_not_editable'];

/** Fixed sentences, by the id endings that may label each (an id containing "import"). */
const SENTENCES: Readonly<Record<string, readonly string[]>> = {
  'the duplicate rule (I7)': ['.duplicate_rule', '.duplicateRule'],
  'the restrict-only note (I6)': ['.restrict_only', '.restrictOnly'],
  'duplicates were skipped (D-L151)': ['.duplicates_skipped', '.duplicatesSkipped'],
  'no restriction was applied to existing contacts (D-L151)': ['.no_restriction', '.noRestriction', '.no_restriction_applied', '.noRestrictionApplied'],
  'the whole-row label (I9)': ['.whole_row', '.wholeRow'],
};

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the mock's validators
  // fire (and the store works cross-origin), so every afterEach "no
  // violations" means something.
  ['@p28-import-mock', 'the contract mock refuses what the contract and the screen’s rules refuse, and checks its own answers'],
  // Passes before the work starts too (there is no route): a negative
  // invariant, given meaning by @p28-import-flag-on.
  ['@p28-import-flag-off', '/contacts/import is a 404 with crm_import at its default, and the browser cannot flip it'],
  ['@p28-import-flag-on', '/contacts/import renders P28 in the CRM shell: a labelled four-step list and the history'],
  ['@p28-import-entry', 'the Contacts list links the screen; no link on the screen is a 404'],
  ['@p28-import-programme', 'the target is a session programme by name; a 403 is translated and nothing uploads'],
  ['@p28-import-contacts-only', 'contacts only: no object chooser'],
  ['@p28-import-limit', 'the 25 MiB limit is stated; CSV only'],
  ['@p28-import-too-large', 'A1: over 25 MiB refused before anything is sent, with advice; exactly 25 MiB declared'],
  ['@p28-import-upload', 'one exact declaration, byte-exact parts to the issued URLs with no credentials, one complete with ETags'],
  ['@p28-import-content-type', 'Windows’ and untyped .csv declared validly; .xlsx never uploads'],
  ['@p28-import-pause', 'pause stops new parts; resume continues the same upload'],
  ['@p28-import-retry', 'a failed part is retried; a part that keeps failing ends, bounded, translated'],
  ['@p28-import-expiry', 'an expired URL is re-issued for the remaining parts only'],
  ['@p28-import-abort', 'cancelling an upload aborts it and stops the parts'],
  ['@p28-import-mismatch', '422 upload_mismatch translated; starting over is a new declaration'],
  ['@p28-import-device', 'the file is never read by script or kept on the device; no cell reaches the page (D-P21)'],
  ['@p28-import-secrets', 'signed URLs and the filename never in the console, address bar, history, links, title or API URLs'],
  ['@p28-import-markup', 'markup in a header or a filename is drawn as text, never parsed'],
  ['@p28-import-mapping', 'the header is polled for; rows prefilled from the suggestion; only ImportField choices, translated'],
  ['@p28-import-required', 'the checklist requires a name only and blocks Continue until met'],
  ['@p28-import-duplicate-mapping', 'a repeated non-repeatable field never runs; phones may repeat'],
  ['@p28-import-reuse', 'reuse sends fromImportId and shows the result; erased imports not offered; unknown_reference translated'],
  ['@p28-import-read-only', 'after field_not_editable the field is offered no more and never sent again'],
  ['@p28-import-compliance', 'compliance mapping shown as restrict-only (D-P28)'],
  ['@p28-import-phones', 'A4: NG, GH, KE, ZA; the duplicate rule in words; no preview, no name-and-birth rule'],
  ['@p28-import-run', 'run once, polled with backoff, live counts in a live region, report, polling stops'],
  ['@p28-import-poll-failure', 'a dropped poll is retried'],
  ['@p28-import-cancel', 'cancel ends the run cancelled with its counts'],
  ['@p28-import-conflict', '409 import_status_conflict translated, the job read again'],
  ['@p28-import-report', 'counts and { row, column, code } only, translated; D-L151’s note; the Contacts link by importId'],
  ['@p28-import-contacts-filter', 'the Contacts list sends importId'],
  ['@p28-import-no-download', 'no download, undo, retry of failed rows or "updated" count (D-L128 Q6)'],
  ['@p28-import-failed', 'a failed import is a translated failed report with its counts'],
  ['@p28-import-history', 'the history as served: translated statuses, programme names, counts; each opens'],
  ['@p28-import-erased', 'an erased import: neutral label, never "null", columns by position (D-L148)'],
  ['@p28-import-axe', 'every step axe-clean; aria-current moves; the progress is a named progressbar'],
  ['@p28-import-mobile', '360 px: upload, mapping and report without sideways scroll, axe-clean'],
  ['@p28-import-pseudo', 'en-XA renders every string as pseudo text, record data excepted'],
  ['@p28-import-budget', '/contacts/import inside its byte budget on the production build'],
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

/** Shared shells other suites hold. The CRM shell is followed for its imports but never counted as the slice's own. */
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

/** The slice: the route directory and everything it imports by a relative path, transitively, minus the shared shells. */
function screenSlice(): SourceFile[] {
  expect(existsSync(fromRoot(ROUTE)), `there is no ${ROUTE}`).toBe(true);
  const sources = new Map(webSources().map((entry) => [entry.file, entry.source]));
  const roots = [...sources.keys()].filter((file) => file.startsWith(ROUTE_DIRECTORY));
  const files = [...reachableFrom(roots, true, OTHER_SHELLS, sources)].sort();
  const slice = files.map((file) => ({ file, source: sources.get(file) ?? '' }));
  expect(
    slice.filter(({ source }) => /['"`]P28['"`]/.test(withoutComments(source))).map(({ file }) => file),
    'the /contacts/import route imports no P28 screen (data-screen="P28")',
  ).not.toEqual([]);
  return slice;
}

/** apps/web/lib modules that call the import API. */
function importClients(): SourceFile[] {
  return webSources().filter(({ file, source }) => file.startsWith('apps/web/lib/') && withoutComments(source).includes(IMPORTS_PATH));
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8')) as Record<string, string>;
}

const BUDGET_LITERAL = /const IMPORT_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8').replace(/\r\n/g, '\n').replace(BUDGET_LITERAL, 'const IMPORT_BUDGET_BYTES = <budget>;');
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

function enumOf(schemaName: string): string[] {
  const node = contract().components.schemas[schemaName]?.enum;
  return Array.isArray(node) ? node.map(String) : [];
}

function camel(code: string): string {
  return code.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** en.json ids containing every one of `parts` (case-insensitive) and ending with one of `suffixes`. */
function keysFor(en: Record<string, string>, parts: readonly string[], suffixes: readonly string[]): string[] {
  return Object.keys(en).filter((id) => parts.every((part) => id.toLowerCase().includes(part.toLowerCase())) && suffixes.some((suffix) => id.endsWith(suffix)));
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

/** A device-storage API (D-P21): web storage, IndexedDB, caches, service workers, the file system. */
const DEVICE_STORAGE = /\b(localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|navigator\.storage|document\.cookie|showSaveFilePicker|showOpenFilePicker|getDirectory)\b/;

/** Reading the file in the page (I4): a reader, a decoder, a parser, a worker or the onboarding header reader. */
function fileReads(source: string): string[] {
  const code = withoutComments(source);
  return code.match(/\bFileReader\b|\breadAs(?:Text|ArrayBuffer|DataURL|BinaryString)\b|\bTextDecoder\b|\bnew\s+Worker\b|['"](?:papaparse|csv-parse|csv-parser|xlsx|exceljs|@sheet\/[\w-]+|d3-dsv)['"]|lib\/csv-columns|\bsummariseCsv\b|\bguessField\b/g) ?? [];
}

/**
 * A storage host, SDK or adapter named in the browser (I3: the browser PUTs
 * only to the URLs the API issued). Anywhere in apps/web.
 */
function storageNames(source: string): string[] {
  const code = withoutComments(source);
  return code.match(/@aws-sdk\/[\w-]+|@kasuwa\/storage-adapter|amazonaws\.com|storage\.example|seaweed|minio|:59000\b/gi) ?? [];
}

/**
 * The storage endpoint read by the screen or its client: they never build a
 * part URL. (A server-only CSP may name the public endpoint, D-L150, so this
 * one is held on the slice and the client only.)
 */
function storageEndpoint(source: string): string[] {
  return withoutComments(source).match(/\bS3_(?:PUBLIC_)?ENDPOINT\b|\bpublicEndpoint\b|\bstorageEnv\b/g) ?? [];
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

/** The test tags in a spec's code (titles and annotations), comments and package scopes excluded. */
function tagsIn(file: string): string[] {
  return [...withoutComments(readFileSync(fromRoot(file), 'utf8')).matchAll(/@[a-z0-9][\w-]*/gi)].map((match) => match[0]).filter((tag) => /^@(p\d|leads|harness)/i.test(tag));
}

/** A spec's parent tag: the one every other tag in it starts with (the shortest), if any. */
function parentTag(tags: readonly string[]): string | undefined {
  const shortest = [...new Set(tags)].sort((left, right) => left.length - right.length)[0];
  return shortest !== undefined && tags.every((tag) => tag.startsWith(shortest)) ? shortest : undefined;
}

// ===========================================================================
// 1. The flag, the route, the link, the harness and the client
// ===========================================================================

describe('acceptance: T-0096 — crm_import exists, is off, is not production-ready, and gates /contacts/import and its link', () => {
  it('registers crm_import, not production-ready, and it evaluates OFF by default (I1)', async () => {
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

  it('has /contacts/import calling notFound() on crm_import, read on the server only', () => {
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

  it('lists import in crmLiveNav() only through crm_import, and links /contacts/import only where live.includes("import") (I1)', () => {
    const live = flagFunctionBody('crmLiveNav');
    expect(live, 'crmLiveNav() is gone from lib/feature-flags.ts').not.toBe('');
    expect(live, 'crmLiveNav() never lists import').toMatch(/['"]import['"]/);
    const readers = readersOf(FLAG).filter((name) => name !== 'crmLiveNav');
    expect(
      readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(live)) || new RegExp(`['"]${FLAG}['"]`).test(live),
      'crmLiveNav() does not read crm_import: the link would show with the flag off',
    ).toBe(true);
    const linking = webSources().filter(({ file, source }) => !file.startsWith(ROUTE_DIRECTORY) && /['"`]\/contacts\/import['"`]/.test(withoutComments(source)));
    expect(linking.map(({ file }) => file), 'nothing links /contacts/import: the screen has no entry').not.toEqual([]);
    for (const { file, source } of linking) {
      expect(withoutComments(source), `${file} links /contacts/import without asking live.includes("import")`).toMatch(/\.includes\(\s*['"]import['"]\s*\)/);
    }
    expect(linking.some(({ file }) => file.startsWith(CONTACTS_DIRECTORY) || file.startsWith(SHELL_DIRECTORY)), 'neither the Contacts list nor the CRM shell links the screen').toBe(true);
  });

  it('serves the journeys from the records process with crm_import on, publishes webImportUrl, and leaves the default server flagless (I1)', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    const processes = [...runner.matchAll(/KASUWA_FEATURE_FLAGS_ON:\s*['"`]([^'"`]*)['"`]/g)].map((match) => (match[1] ?? '').split(/[,\s]+/));
    expect(
      processes.some((flags) => flags.includes(FLAG) && RECORDS_PROCESS_FLAGS.every((flag) => flags.includes(flag))),
      `no web process in run-e2e.mjs carries ${FLAG} beside ${RECORDS_PROCESS_FLAGS.join(', ')}`,
    ).toBe(true);
    expect(runner, 'run-e2e.mjs does not publish webImportUrl in the stack file').toContain('webImportUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*''/);
  });

  it('calls the import API same-origin, Zod-parsed, with no scope argument; never names a storage host, an S3 SDK or the adapter (I3)', () => {
    const clients = importClients();
    expect(clients.map(({ file }) => file), `no apps/web/lib module calls ${IMPORTS_PATH}`).not.toEqual([]);
    for (const { file, source } of clients) {
      const code = withoutComments(source);
      expect(code, `${file} names an absolute API origin`).not.toMatch(/https?:\/\/[^'"`]*\/api\/v1/);
      expect(code, `${file} does not parse with Zod`).toMatch(/from ['"]zod['"]/);
      expect(code, `${file} builds a scope argument`).not.toMatch(/programmeIds|ownerUserIds|(set|append)\(\s*['"`](programme|owner|scope)|['"`]x-[\w-]*(programme|tenant|scope)/i);
    }
    for (const { file, source } of webSources()) {
      expect(storageNames(source), `${file} names a storage host, an S3 SDK or the storage adapter: the browser PUTs only to the URLs it is given`).toEqual([]);
      expect(withoutComments(source), `${file} imports test support`).not.toMatch(/from ['"][^'"]*(tests\/e2e|import-mock|records-mock|@kasuwa\/testing)[^'"]*['"]/);
    }
  });

  it('keeps the import screen out of every other screen’s first load: the CRM shell and the Contacts list import none of it', () => {
    // A static check. The real one is every other records-ui suite's pinned
    // byte budget, which still runs with crm_import on (I1).
    const slice = screenSlice().map(({ file }) => file);
    const own = slice.filter((file) => file.startsWith(ROUTE_DIRECTORY) || /['"`]P28['"`]/.test(readFileSync(fromRoot(file), 'utf8')));
    const roots = [...trackedFiles(SHELL_DIRECTORY), ...trackedFiles(CONTACTS_DIRECTORY), 'apps/web/app/contacts/page.tsx'].filter((file) => /\.(tsx?|mjs)$/.test(file) && !/\.test\.tsx?$/.test(file));
    const loaded = reachableFrom(roots, true, ['apps/web/components/auth/', 'apps/web/components/admin/']);
    expect(own.filter((file) => loaded.has(file)), 'the CRM shell or the Contacts list imports the import screen').toEqual([]);
  });
});

// ===========================================================================
// 2. i18n — the lint rule, every catalogue, D-L150, D-P1
// ===========================================================================

describe('acceptance: T-0096 — every string through i18n, in every catalogue, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the /contacts/import route file', () => {
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(/files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/);
    // A rule only ever seen passing proves nothing: plant a literal at the route's own path.
    const planted = eslint(['--stdin', '--stdin-filename', ROUTE, '--format', 'json'], 'export default function Planted() {\n  return <p>Import finished</p>;\n}\n');
    expect(planted.output, `a literal JSX string at ${ROUTE} is not rejected:\n${planted.output.slice(-2000)}`).toContain('i18next/no-literal-string');
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const slice = screenSlice();
    const run = eslint(['--max-warnings', '0', ...slice.map(({ file }) => file)]);
    expect(run.status, `eslint fails on the import slice:\n${run.output.slice(-4000)}`).toBe(0);
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('puts every message the slice names, and a label for every row error, refusal, status and fixed sentence, in every design-menu catalogue', async () => {
    const i18n: { DESIGN_MENU_LOCALES: readonly string[] } = await import(fromRoot('packages/i18n/src/index.ts'));
    const en = catalogue('en');
    const named = new Set<string>();
    for (const { source } of screenSlice()) {
      for (const match of withoutComments(source).matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)) {
        if (match[1] !== undefined && en[match[1]] !== undefined) named.add(match[1]);
      }
    }
    // Vacuity guard: the CRM shell alone names about a dozen ids; the import screen must add its own.
    expect([...named].filter((id) => /import/i.test(id)).length, 'the import slice names almost no import message id').toBeGreaterThan(15);

    const one = (what: string, parts: readonly string[], suffixes: readonly string[]): string => {
      const found = keysFor(en, parts, suffixes);
      expect(found.length, `en.json has no label for ${what} (an id containing ${parts.map((part) => `"${part}"`).join(' and ')} ending ${suffixes.join(' or ')})`).toBeGreaterThan(0);
      return found[0] ?? `<missing ${what}>`;
    };
    const rowCodes = enumOf('ImportRowErrorCode');
    expect(rowCodes.length, 'the contract’s row-error codes are gone').toBeGreaterThan(10);
    const statuses = enumOf('ImportStatus');
    expect(statuses.length).toBe(10);
    const required = [
      ...[...rowCodes, ...REFUSAL_CODES].map((code) => one(`the ${code} code`, ['import', 'error'], [`.${code}`, `.${camel(code)}`])),
      ...statuses.map((status) => one(`the ${status} status`, ['import', 'status'], [`.${status}`, `.${camel(status)}`])),
      ...Object.entries(SENTENCES).map(([what, suffixes]) => one(what, ['import'], suffixes)),
      one('the A1 advice', ['import', 'advice'], ['']),
      one('the erased-file label', ['import', 'erased'], ['']),
      one('the truncation note', ['import', 'truncated'], ['']),
    ];
    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const key of [...named, ...required]) {
        if (typeof messages[key] !== 'string' || messages[key].trim() === '') missing.push(`${locale}: ${key}`);
      }
    }
    expect(missing, 'message ids the import screen uses that a catalogue lacks').toEqual([]);
    for (const code of [...rowCodes, ...REFUSAL_CODES]) {
      const key = one(`the ${code} code`, ['import', 'error'], [`.${code}`, `.${camel(code)}`]);
      expect(en[key], `${key} just repeats the code`).not.toContain(code);
    }
    // The duplicate rule names no fuzzy or name-and-birth match (D-P12).
    const rule = en[one('the duplicate rule (I7)', ['import'], SENTENCES['the duplicate rule (I7)'] ?? [])] ?? '';
    expect(rule, 'the duplicate rule names a match the import does not make').not.toMatch(/birth|name and|similar|fuzzy|confidence/i);
    expect(rule, 'the duplicate rule does not name phone and email').toMatch(/phone/i);
    expect(rule).toMatch(/email/i);
    const restrict = en[one('the restrict-only note (I6)', ['import'], SENTENCES['the restrict-only note (I6)'] ?? [])] ?? '';
    expect(restrict, 'the restrict-only note promises the most recent choice (D-P28 is most restrictive)').not.toMatch(/most recent|latest/i);
  });

  it('localises every error the nine import operations can answer with, import_status_conflict and upload_mismatch included (D-L150)', () => {
    const en = catalogue('en');
    const codes = new Set(IMPORT_OPERATIONS.flatMap(([path, method]) => errorCodes(path, method)));
    expect([...codes], 'the import operations no longer declare their own codes').toEqual(expect.arrayContaining(['import_status_conflict', 'upload_mismatch', 'not_permitted', 'not_found']));
    const admin = parse(readFileSync(fromRoot(ADMIN_CONTRACT), 'utf8')) as { components: { schemas: { Error: { properties: { code: { enum: string[] } } } } } };
    expect(admin.components.schemas.Error.properties.code.enum, 'the shared Error envelope lost an import code').toEqual(expect.arrayContaining(['import_status_conflict', 'upload_mismatch']));
    const missing = [...codes].filter((code) => en[`records.error.${code}`] === undefined);
    expect(missing, 'en.json lacks records.error.<code> for these errors').toEqual([]);
    for (const code of codes) {
      expect(en[`records.error.${code}`] ?? '', `records.error.${code} just repeats the code`).not.toContain(code);
    }
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
// 3. Colour, the device, the file and the storage
// ===========================================================================

describe('acceptance: T-0096 — no colour literal, no device storage, no client-side read of the file', () => {
  it('the detectors catch what they are for', () => {
    // Planted first: a detector only ever seen finding nothing proves nothing.
    // Passes before the work starts, by design.
    for (const planted of ['className="text-[#c00] p-2"', "style={{ color: 'red' }}", 'className="bg-sky-100"', 'className="border-white"']) {
      expect(colourLiterals(planted), `the colour detector missed ${planted}`).not.toEqual([]);
    }
    expect(colourLiterals('className="bg-surface text-text-2 border-border-strong bg-primary-soft"')).toEqual([]);
    for (const planted of ["localStorage.setItem('upload', id)", 'await navigator.storage.getDirectory()', 'indexedDB.open("parts")', 'await caches.open("x")']) {
      expect(DEVICE_STORAGE.test(planted), `the device-storage detector missed ${planted}`).toBe(true);
    }
    for (const planted of [
      'const reader = new FileReader();',
      'reader.readAsText(file);',
      'new TextDecoder().decode(bytes)',
      "import Papa from 'papaparse';",
      "import { read } from 'xlsx';",
      "import { summariseCsv } from '../../lib/csv-columns';",
      "const worker = new Worker(new URL('./parse.ts', import.meta.url));",
    ]) {
      expect(fileReads(planted), `the file-read detector missed ${planted}`).not.toEqual([]);
    }
    expect(fileReads("await fetch(part.url, { method: 'PUT', body: file.slice(start, end) });")).toEqual([]);
    for (const planted of ["import { S3Client } from '@aws-sdk/client-s3';", "import { presign } from '@kasuwa/storage-adapter';", "const base = 'https://kasuwa.s3.af-south-1.amazonaws.com';", 'http://localhost:59000/kasuwa']) {
      expect(storageNames(planted), `the storage detector missed ${planted}`).not.toEqual([]);
    }
    expect(storageNames("await fetch(part.url, { method: 'PUT', body })")).toEqual([]);
    expect(storageEndpoint("const origin = webEnv().S3_PUBLIC_ENDPOINT;"), 'the endpoint detector missed S3_PUBLIC_ENDPOINT').not.toEqual([]);
    expect(storageEndpoint("await fetch(part.url, { method: 'PUT', body })")).toEqual([]);
    // The first-load walk, on planted modules: a static import is seen, a dynamic one only when asked.
    const shell = 'apps/web/components/crm/crm-shell.tsx';
    const screen = 'apps/web/components/import/import-screen.tsx';
    const planted = (code: string) => new Map([[shell, code], [screen, "export const id = 'P28';"]]);
    expect(reachableFrom([shell], false, [], planted("import { ImportScreen } from '../import/import-screen';")).has(screen)).toBe(true);
    expect(reachableFrom([shell], false, [], planted("import type { ImportScreenProps } from '../import/import-screen';")).has(screen)).toBe(false);
    expect(reachableFrom([shell], true, [], planted("const Lazy = dynamic(() => import('../import/import-screen'));")).has(screen)).toBe(true);
  });

  it('writes no colour literal anywhere in the slice', () => {
    const found = screenSlice().flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the import slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('touches no device-storage API and never reads the file in the page (I4, D-P21)', () => {
    const files = [...screenSlice(), ...importClients()];
    expect(files.filter(({ source }) => DEVICE_STORAGE.test(withoutComments(source))).map(({ file }) => file), 'the import slice uses a device-storage API').toEqual([]);
    expect(files.flatMap(({ file, source }) => fileReads(source).map((hit) => `${file}: ${hit}`)), 'the import slice reads or parses the file in the page').toEqual([]);
    expect(files.flatMap(({ file, source }) => storageEndpoint(source).map((hit) => `${file}: ${hit}`)), 'the import slice reads the storage endpoint: it only ever PUTs to the URLs the API issued').toEqual([]);
  });

  it('adds no CSV or spreadsheet library to the web app (a client-side parse is a non-goal)', () => {
    const manifest = JSON.parse(readFileSync(fromRoot('apps/web/package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(names.filter((name) => /csv|xlsx|excel|sheet|papaparse|dsv|^@aws-sdk\//i.test(name)), 'apps/web depends on a parser or an S3 SDK').toEqual([]);
  });
});

// ===========================================================================
// 4. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0096 — the journeys and the mock are the ones this suite was written with', () => {
  it('pins p28-import.spec.ts and import-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(normalisedHash(file), `${file} changed. It is part of the T-0096 acceptance contract: ask the lead to re-pin it (only IMPORT_BUDGET_BYTES may move without that).`).toBe(pinned);
    }
    const mock = readFileSync(fromRoot(MOCK), 'utf8');
    expect(mock, 'the mock no longer reads the records contract').toContain(CONTRACT);
    expect(mock, 'the mock no longer checks its own answers against the contract').toMatch(/answerProblems\(operation, status, body\)/);
    expect(mock, 'the mock no longer reads the published limits').toContain("'x-kasuwa-import-limits'");
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    expect(BUDGET_LITERAL.test(spec), 'IMPORT_BUDGET_BYTES is not where it was').toBe(true);
    expect(spec, 'the journeys no longer watch for script reads of the file').toContain('__kasuwaFileReads');
  });
});

// ===========================================================================
// 5. The tag is this screen's alone (D-L84)
// ===========================================================================

describe('acceptance: T-0096 — @p28-import selects these journeys and nothing else', () => {
  it('no other spec carries a tag @p28-import matches, no other parent tag matches ours, and the spec carries only ours', () => {
    // Passes before the work starts: it guards later specs (T-0097's
    // duplicates screen is P28 too) against colliding with this one.
    const specs = trackedFiles('tests/e2e').filter((file) => file.endsWith('.spec.ts') && existsSync(fromRoot(file)));
    expect(specs).toContain(SPEC);
    // The parent-tag rule on planted tags: a later `@p28-duplicates` and ours
    // share a prefix and must not collide; a bare `@p28` parent would.
    const duplicates = ['@p28-duplicates', '@p28-duplicates-merge'];
    expect(parentTag(duplicates)).toBe('@p28-duplicates');
    expect(new RegExp('@p28-duplicates').test(E2E_TAG)).toBe(false);
    expect(duplicates.filter((tag) => new RegExp(E2E_TAG).test(tag))).toEqual([]);
    expect(new RegExp(parentTag(['@p28', '@p28-list']) ?? '(none)').test(E2E_TAG), 'a bare @p28 parent was not caught').toBe(true);
    const ours = tagsIn(SPEC);
    expect(ours.length).toBeGreaterThan(REQUIRED.length);
    expect(ours.filter((tag) => tag !== E2E_TAG && !tag.startsWith(`${E2E_TAG}-`)), 'the spec carries another screen’s tag').toEqual([]);
    for (const [tag] of REQUIRED) {
      expect(ours, `no journey carries ${tag}`).toContain(tag);
    }
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
// 6. The browser — one run of @p28-import
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0096 e2e run did not start', outcomes: undefined, startedAt: 0 };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

function outcomes(): E2eOutcome[] {
  expect(e2eRun.outcomes, `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-6000)}`).toBeDefined();
  return e2eRun.outcomes ?? [];
}

describe('acceptance: T-0096 — the import wizard in a browser', () => {
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

  it('runs every @p28-import journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(journeys.length, 'the run reported fewer @p28-import tests than there are behaviours').toBeGreaterThanOrEqual(REQUIRED.length);
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p28-import tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter((outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag));
      expect(proving.length, `no PASSING @p28-import test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('pins /contacts/import at or under 255,000 bytes and within 5% of what this run measured (I11)', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'IMPORT_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /contacts/import budget is above its ceiling').toBeLessThanOrEqual(IMPORT_BUDGET_CEILING);
    expect(budget).toBeLessThan(PRD_CEILING_BYTES);
    const record = fromRoot(BUDGET_RECORD);
    expect(existsSync(record), 'the budget test wrote no measurement').toBe(true);
    expect(statSync(record).mtimeMs, 'the measurement is older than this run').toBeGreaterThanOrEqual(e2eRun.startedAt);
    const measured = (JSON.parse(readFileSync(record, 'utf8')) as { transferredBytes: number }).transferredBytes;
    expect(measured, 'the measurement is empty').toBeGreaterThan(0);
    expect(budget, `the budget is under the ${measured} bytes measured`).toBeGreaterThanOrEqual(measured);
    expect(budget, `the budget is more than 5% over the ${measured} bytes measured — the lead re-pins IMPORT_BUDGET_BYTES`).toBeLessThanOrEqual(Math.round(measured * BUDGET_HEADROOM));
  });
});
