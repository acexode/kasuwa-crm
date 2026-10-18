import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FLAGS,
  featureFlagClient,
  initialiseFeatureFlags,
  toEvaluationContext,
} from '@kasuwa/feature-flags';
import { OUTCOMES_FILE, type E2eOutcome } from '../support/e2e-outcomes-reporter';

/**
 * ACCEPTANCE — T-0091, custom-field values on the record screens and the two
 * supported list filters (Agent 11, Frontend & Design System), against
 * T-0088's contract and T-0089's API. Decisions: ADR-0016, D-L128 (Q1, Q4,
 * Q6), D-L138 to D-L143, D-L84, D-L64, D-P17, D-P25.
 * Written by the lead's QA agent before the screens exist (D-L23).
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. `crm_custom_fields` (the name T-0090's studio suite pins, confirmed by
 *      the lead; the studio at `/admin/custom-fields` and these screens share
 *      it): registered, DEFAULT OFF, NOT
 *      production-ready, read on the server through `lib/feature-flags.ts`
 *      by every route that shows or filters custom values. No client module
 *      names it. With it off the screens are unchanged (held here,
 *      statically: no process serves a record screen with it off).
 *   2. The harness: the builder adds it to the RECORDS web process in the
 *      change that registers it (naming an unregistered flag stops that
 *      process booting, so this suite cannot add it, as T-0087 R3). Every
 *      older records-ui and scripting-ui suite then runs with it ON and no
 *      definitions (their mocks answer listCustomFields with an empty list):
 *      they must still pass, inside their pinned byte budgets. That is the
 *      budget check; this slice adds no route.
 *   3. A client in `apps/web/lib/` reads listCustomFields same-origin,
 *      Zod-parsed, with no scope argument and never `includeRetired=true`.
 *   4. The record screens, the activity forms and the list filters against
 *      the contract mocks, by e2e tag (section 6; the hooks, formats and
 *      edit rules are in the header of `tests/e2e/p18-custom-values.spec.ts`).
 *   5. i18n: the literal-string rule fires on the slice; every message id the
 *      slice names is in every design-menu catalogue; translated messages for
 *      the five custom codes and the boolean's yes and no.
 *   6. No colour literal, no hard-coded currency symbol, no float arithmetic
 *      on an amount, and no device storage in the slice.
 *
 * RULINGS (the suite is written to these; the lead accepts or amends them)
 *
 *   C1. Flag. One flag gates every custom-value surface (records, activity
 *       forms, filters): `crm_custom_fields`, shared with the T-0090 studio
 *       (confirmed). Whichever change registers it first adds it to the
 *       records process; the other suite's static checks then hold too.
 *   C2. The lead's record is the contact record (D-P17): `/contacts/<id>` at
 *       a lead status. The Leads list carries the filters.
 *   C3. Activities show their custom values nowhere on a read: `MyActivity`
 *       and timeline items carry no `custom`. The activity forms (the record
 *       activity form and the P07 composer) take them on create, values only.
 *   C4. Read-only keys. There is no capability read (D-L84), so a key is
 *       known to be read-only only from `403 field_not_editable` at
 *       `custom.<key>`. From then on its control is disabled, read-only or
 *       gone, and it is never sent again in that session. A withheld key has
 *       no control at all.
 *   C5. "Is empty" is the option value `is-empty` on a custom filter (a
 *       picklist value can never contain `-`). One value per key; choosing
 *       "is empty" replaces an equality on that key.
 *   C6. Custom filters live on the pipeline's LIST view only: listDeals
 *       declares them, getPipelineBoard does not.
 *   C7. Inputs. picklist and boolean are native <select>s whose "" option is
 *       "no value"; date is input[type="date"]; text, number and currency are
 *       inputs that are never type="number"; currency is typed in major units
 *       in the field's one currency (D-L128 Q6) and sent as an integer
 *       minor-unit string; a number is sent canonical (`12.50` → `12.5`).
 *   C8. Formats. Currency, number and date are exactly the browser's own
 *       Intl output for the page's language (any currencyDisplay, any of the
 *       four date styles, grouping on or off); a date is a calendar date
 *       (`timeZone: 'UTC'` on a `YYYY-MM-DD`), proved from a UTC-1 browser.
 *   C9. A failed definitions read never takes the record down and never
 *       draws a value without its definition. A key on a record with no
 *       definition the screen read (a field created since) is not drawn.
 *   C10. Withheld keys are decided per record from its `withheldFields`
 *       (`custom.<key>`), never cached per key across records.
 *
 * PINNED INTERFACES (the builder's side): the DOM hooks in the spec's header;
 * a reader of `crm_custom_fields` in `apps/web/lib/feature-flags.ts`, called
 * (or the flag named) in each route file of ROUTES below; a client in
 * `apps/web/lib/` naming `/api/v1/admin/custom-fields`; labels under ids
 * containing `custom` ending `.invalid_value`, `.custom_too_large` (or
 * `.tooLarge`), `.unknown_field`, `.field_not_editable` (or `.notEditable`),
 * `.field_withheld`, and `.boolean.true` / `.boolean.false` (or `.yes` /
 * `.no`), camel case accepted.
 *
 * BUILDER'S CHOICES: where the custom section sits on each record and how it
 * groups; whether the definitions are read once per screen or cached for the
 * session (the API reads them live, D-L141); the copy; whether a failed
 * definitions read shows a message; whether the read-only key is disabled,
 * read-only or removed; the slice's file layout.
 *
 * NOT HELD HERE, AND WHY
 *   - Activity values on a read (C3): nothing serves them.
 *   - The studio (T-0090): its own suite.
 *   - Sorting on a custom field: there is none; the mocks refuse any `sort`
 *     outside each list's enum, and the journeys check no custom sort is
 *     offered.
 *
 * THE BROWSER HALF. `tests/e2e/p18-custom-values.spec.ts` (journeys),
 * `tests/e2e/support/custom-values-mock.ts` (the custom-field half of the
 * contracts) and the eight screen mocks it was wired into are PINNED by hash
 * below, because `tests/e2e` is not path-protected (D-L64). Each screen mock
 * is also pinned by its own screen's suite, re-pinned in the same change.
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p18-custom-values --reporter=list,<ours>
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

const FLAG = 'crm_custom_fields';

/** The flags of the records process that the custom-fields flag rides on. */
const RECORDS_PROCESS_FLAGS = ['crm_records', 'crm_accounts', 'crm_record_view', 'crm_leads', 'crm_activities', 'crm_pipeline'];

/** Every route that shows, edits or filters custom values. */
const ROUTES = [
  'apps/web/app/contacts/page.tsx',
  'apps/web/app/contacts/[id]/page.tsx',
  'apps/web/app/leads/page.tsx',
  'apps/web/app/accounts/page.tsx',
  'apps/web/app/accounts/[id]/page.tsx',
  'apps/web/app/deals/[dealId]/page.tsx',
  'apps/web/app/pipelines/[pipelineId]/page.tsx',
  'apps/web/app/activities/page.tsx',
];

const E2E_TAG = '@p18-custom-values';

/** `next build` (SWC wasm on the dev host, D-L62), a container, the servers and the journeys. */
const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p18-custom-values.spec.ts';
// Not `custom-fields-mock.ts`: that is T-0090's studio mock, a different file.
const CUSTOM_MOCK = 'tests/e2e/support/custom-values-mock.ts';
const SCREEN_MOCKS = [
  'tests/e2e/support/records-mock.ts',
  'tests/e2e/support/leads-mock.ts',
  'tests/e2e/support/accounts-mock.ts',
  'tests/e2e/support/contact-record-mock.ts',
  'tests/e2e/support/account-record-mock.ts',
  'tests/e2e/support/deal-mock.ts',
  'tests/e2e/support/pipeline-mock.ts',
  'tests/e2e/support/activities-mock.ts',
  // D-L159: the search mock serves the lists a "see all" lands on, so it answers listCustomFields too.
  'tests/e2e/support/search-mock.ts',
];
const CUSTOM_FIELDS_PATH = '/api/v1/admin/custom-fields';

/**
 * The pinned browser half (CRLF folded to LF). A change to any of these is a
 * change to the acceptance contract: the lead re-pins it, the builder does not.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  [SPEC]: '067d9d3e347958a0336054b7d8ed306f5d603271f719707b31ec374322489d35',
  [CUSTOM_MOCK]: '66d7731bf4f6643e18da743efb2c8409f930cee7cd5eaa98f65bdbd622a11d5e',
  'tests/e2e/support/records-mock.ts': 'f2fc83b332de03710a704f983364ed3b36c20b3dd67b46b7499ee6fb94cc2dae',
  'tests/e2e/support/leads-mock.ts': '65395185e35e6937debcac899777e742eba32dc0915ac17cf63a09eab32bb9df',
  'tests/e2e/support/accounts-mock.ts': '6da2ee53f6620bfd025cae52037130eb6546b101d2b0b6bf6461c87c8826ca04',
  'tests/e2e/support/contact-record-mock.ts': '894c18ec5d9337bca3d22aa2cb9119600243c21b7a984cfcbbb15b3ede712a12',
  'tests/e2e/support/account-record-mock.ts': '10629d748960be2ce5d489be649950ab5cf5ad3faaddf8f9c5bb79f8af25a613',
  'tests/e2e/support/deal-mock.ts': 'aad20148fd6a36e54ef490522225622d58ff0b1aa86e9083cd4b0f3d8c2f20e8',
  'tests/e2e/support/pipeline-mock.ts': 'cb5f6a8452b1c44c1828ceaea7fdfc3a154896e96365680e2d955d59667dc6cd',
  'tests/e2e/support/activities-mock.ts': '1e3221cc41550ce894d56e7cab267ac1621ef253929c4bce5f54e75fd63270da',
  'tests/e2e/support/search-mock.ts': '69138384e94d463bd22218f3db2bd0a4d7a30d0f9a98fc49c49cd96d0ca178c9',
};

/** The five custom-field refusals a screen draws, by code, and the id endings that may label each. */
const CUSTOM_CODES: Readonly<Record<string, readonly string[]>> = {
  invalid_value: ['.invalid_value', '.invalidValue'],
  custom_too_large: ['.custom_too_large', '.customTooLarge', '.tooLarge', '.too_large'],
  unknown_field: ['.unknown_field', '.unknownField'],
  field_not_editable: ['.field_not_editable', '.fieldNotEditable', '.notEditable', '.not_editable'],
  field_withheld: ['.field_withheld', '.fieldWithheld'],
};

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the custom-field
  // mock's validators fire, so every afterEach "no violations" means something.
  ['@p18-custom-values-mock', 'the custom-field mock refuses malformed patches, creates and filters, and projects withheld and retired keys'],
  ['@p18-custom-values-contact', 'the contact record shows every active field in its slot and format, the withheld one locked, no retired one'],
  ['@p18-custom-values-lead', 'a lead (a contact at a lead status) shows its custom values on its record (C2)'],
  ['@p18-custom-values-account', 'the account record shows its values, the currency in the field’s GHS, the withheld key locked'],
  ['@p18-custom-values-deal', 'the deal shows its values, the currency in the field’s ZAR, the withheld key locked'],
  ['@p18-custom-values-locale', 'currency, number and date in the caller’s locale (French separators); labels as defined'],
  ['@p18-custom-values-precision', 'an 18-digit amount (positive and negative) and an 18-digit number keep every digit'],
  ['@p18-custom-values-calendar-date', 'a date is the same calendar day in a UTC-1 browser, shown and prefilled (C8)'],
  ['@p18-custom-values-withheld', 'a withheld key: locked slot, no input, its value nowhere in the DOM or any request; decided per record (C10)'],
  ['@p18-custom-values-empty', 'a key with no value is empty, never locked; a withheld key with no value is still locked (D-L141)'],
  ['@p18-custom-values-retired', 'never includeRetired; no slot for a retired key, or for a key the screen has no definition for (C9)'],
  ['@p18-custom-values-definitions-failed', 'a failed definitions read keeps the record and draws no value raw (C9)'],
  ['@p18-custom-values-markup', 'markup in a text value is drawn as text'],
  ['@p18-custom-values-edit', 'a save is a per-key merge of only what changed; a picklist value; a currency in minor units of the field’s currency'],
  ['@p18-custom-values-edit-types', 'a canonical number, a calendar date, a JSON boolean, a line of text (C7)'],
  ['@p18-custom-values-clear', 'clearing sends null per key, and the slot is then empty'],
  ['@p18-custom-values-errors', 'invalid_value, custom_too_large, unknown_field and field_not_editable are translated messages, never raw codes'],
  ['@p18-custom-values-read-only', 'after field_not_editable the key is read-only and never sent again (C4)'],
  ['@p18-custom-values-edit-account', 'the account record saves a per-key merge in GHS minor units; no input for the withheld key'],
  ['@p18-custom-values-edit-deal', 'the deal saves a per-key merge in ZAR minor units; no input for the withheld key'],
  ['@p18-custom-values-activity-form', 'the record’s activity form offers the activity fields and creates with filled values only (C3)'],
  ['@p18-custom-values-activity-compose', 'the P07 composer offers the activity fields, creates with values only, translates field_not_editable'],
  ['@p18-custom-values-filter-contacts', 'the contacts list: picklist and boolean filters only, labelled; custom[key] and customEmpty; no custom sort'],
  ['@p18-custom-values-filter-leads', 'the leads list filters with custom[key]'],
  ['@p18-custom-values-filter-accounts', 'the accounts list filters on a picklist and on "is empty" (C5)'],
  ['@p18-custom-values-filter-deals', 'the pipeline’s list view filters with custom[key]; the board read never carries one (C6)'],
  ['@p18-custom-values-filter-withheld', 'a 400 field_withheld on a filter is a translated message, not the generic one'],
  ['@p18-custom-values-axe', 'the record with custom values and its edit form are axe-clean; every custom input is named'],
  ['@p18-custom-values-mobile', '360 px: no sideways scroll on the record or the edit form, axe-clean'],
  ['@p18-custom-values-pseudo', 'en-XA renders every custom-field string as pseudo text; labels and values are record data'],
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

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** What marks a file as part of the custom-values slice. */
const SLICE_MARKERS = [/data-custom-field/, /data-custom-input/, /data-custom-value/, /\/api\/v1\/admin\/custom-fields/, /['"`]customEmpty['"`]/];

/**
 * T-0090's studio (D-L159): its client and model name the custom-fields path
 * and may ask for retired fields (the studio shows which api names are taken).
 * They are the studio suite's to hold, never part of this record-side slice.
 */
const STUDIO_MODULES = ['apps/web/lib/custom-fields-api.ts', 'apps/web/lib/custom-field-model.ts'];

function studioModule(file: string): boolean {
  return STUDIO_MODULES.includes(file) || /^apps\/web\/(components|app)\/admin\//.test(file);
}

/**
 * Every place a record-side module names `includeRetired` with anything but a
 * literal false: `true`, `'true'`, `String(true)`, a variable, a shorthand
 * property. A record screen never asks for retired definitions (D-L159).
 */
function retiredAsks(source: string): string[] {
  return [...withoutComments(source).matchAll(/includeRetired['"`]?\s*(?:[:=,]\s*)?([^,;)}\n]*)/g)]
    .filter((match) => !/^['"`]?false['"`]?$/.test((match[1] ?? '').trim()))
    .map((match) => match[0].trim());
}

/**
 * The slice: every record-side apps/web module (tests and the studio
 * excluded) that draws a custom slot, input or value, reads the definitions,
 * or builds a custom filter. Refused unless it exists and names every hook
 * somewhere.
 */
function slice(): SourceFile[] {
  const files = webSources().filter(({ file, source }) => !studioModule(file) && SLICE_MARKERS.some((marker) => marker.test(withoutComments(source))));
  expect(files.map(({ file }) => file), 'no apps/web module draws data-custom-field or reads listCustomFields: custom values are not built').not.toEqual([]);
  const code = files.map(({ source }) => withoutComments(source)).join('\n');
  for (const hook of ['data-custom-field', 'data-custom-input', 'data-custom-value']) {
    expect(code, `nothing in the slice draws ${hook}`).toContain(hook);
  }
  return files;
}

/** Record-side apps/web/lib modules that call listCustomFields (the studio's client excluded, D-L159). */
function definitionClients(): SourceFile[] {
  return webSources().filter(
    ({ file, source }) => file.startsWith('apps/web/lib/') && !studioModule(file) && withoutComments(source).includes(CUSTOM_FIELDS_PATH),
  );
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8')) as Record<string, string>;
}

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/**
 * Colour written into a web source rather than read from a token (D-L84: the
 * lint rule sees only a string that IS a hex value). The same detector as the
 * other records-ui suites.
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

/** A currency symbol typed into code: the symbol is Intl's to choose, from the field's code. */
function currencySymbols(source: string): string[] {
  const code = withoutComments(source);
  return [...(code.match(/[₦₵]|GH₵|KSh|['"`]R\s?['"`]|['"`]R\d/g) ?? [])];
}

/**
 * Float arithmetic on money or a decimal (a heuristic; the 18-digit journey is
 * the real check): parseFloat, Number() or a unary plus on an amount, a
 * division or multiplication by a bare 100 (BigInt `100n` is fine), toFixed.
 */
function floatMoney(source: string): string[] {
  const code = withoutComments(source);
  return [
    ...(code.match(/\bparseFloat\s*\(/g) ?? []),
    ...(code.match(/\bNumber\s*\(\s*[\w.?]*(?:amountMinor|amount|value)\b/g) ?? []),
    ...(code.match(/[/*]\s*100\b(?!n)/g) ?? []),
    ...(code.match(/\.toFixed\s*\(/g) ?? []),
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

/** A spec's parent tag: the one every other tag in it starts with (the shortest), if any. */
function parentTag(tags: readonly string[]): string | undefined {
  const shortest = [...new Set(tags)].sort((left, right) => left.length - right.length)[0];
  return shortest !== undefined && tags.every((tag) => tag.startsWith(shortest)) ? shortest : undefined;
}

// ===========================================================================
// 1. The flag, the routes, the harness and the client
// ===========================================================================

describe('acceptance: T-0091 — crm_custom_fields exists, is off, is not production-ready, and gates every custom-value route', () => {
  it('registers crm_custom_fields, not production-ready, and it evaluates OFF by default (C1)', async () => {
    // `true` as the fallback on purpose: an unregistered flag returns the
    // fallback, so only a flag that is registered AND defaults off answers false.
    expect(Object.keys(FLAGS), `${FLAG} is not declared in FLAGS (see C1)`).toContain(FLAG);
    const definition = (FLAGS as Readonly<Record<string, { productionReady?: boolean; defaultValue?: boolean }>>)[FLAG];
    expect(definition?.defaultValue, `${FLAG} does not default off`).toBe(false);
    expect(definition?.productionReady, `${FLAG} is marked production-ready`).toBe(false);
    await initialiseFeatureFlags();
    const value = await featureFlagClient().getBooleanValue(FLAG, true, toEvaluationContext({ tenantId: 'acceptance-probe' }));
    expect(value, `${FLAG} does not evaluate OFF by default`).toBe(false);
  });

  it('reads it on the server in every route that shows, edits or filters custom values, and in no client module', () => {
    const readers = readersOf(FLAG).filter((name) => name !== 'crmLiveNav');
    expect(readers, `apps/web/lib/feature-flags.ts has no reader that evaluates ${FLAG}`).not.toEqual([]);
    for (const route of ROUTES) {
      expect(existsSync(fromRoot(route)), `${route} is gone`).toBe(true);
      const source = withoutComments(readFileSync(fromRoot(route), 'utf8'));
      const gated = readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source)) || new RegExp(`['"]${FLAG}['"]`).test(source);
      expect(gated, `${route} does not read ${FLAG} (readers: ${readers.join(', ') || 'none'}): with the flag off its screen must be unchanged`).toBe(true);
    }
    const clientEvaluators = webSources().filter(({ source }) => /^\s*['"]use client['"]/m.test(source) && source.includes(FLAG));
    expect(clientEvaluators.map(({ file }) => file), `a client module names ${FLAG}: flags are read on the server only`).toEqual([]);
  });

  it('serves the journeys from the records process with crm_custom_fields on, and leaves the default server flagless', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    const processes = [...runner.matchAll(/KASUWA_FEATURE_FLAGS_ON:\s*['"`]([^'"`]*)['"`]/g)].map((match) => (match[1] ?? '').split(/[,\s]+/));
    expect(
      processes.some((flags) => flags.includes(FLAG) && RECORDS_PROCESS_FLAGS.every((flag) => flags.includes(flag))),
      `no web process in run-e2e.mjs carries ${FLAG} beside ${RECORDS_PROCESS_FLAGS.join(', ')}`,
    ).toBe(true);
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*''/);
  });

  it('reads the definitions same-origin, Zod-parsed, with no scope argument and never the retired ones', () => {
    const clients = definitionClients();
    expect(clients.map(({ file }) => file), `no apps/web/lib module calls ${CUSTOM_FIELDS_PATH}`).not.toEqual([]);
    for (const { file, source } of clients) {
      const code = withoutComments(source);
      expect(code, `${file} names an absolute API origin`).not.toMatch(/https?:\/\/[^'"`]*\/api\/v1/);
      expect(code, `${file} does not parse with Zod`).toMatch(/from ['"]zod['"]/);
      expect(code, `${file} builds a scope argument`).not.toMatch(/programmeIds?|ownerUserIds|(set|append)\(\s*['"`](programme|owner|scope)|['"`]x-[\w-]*(programme|tenant|scope)/i);
    }
    // Every record-side module, the slice included: any includeRetired but a literal false (D-L159).
    for (const { file, source } of [...clients, ...slice()]) {
      expect(retiredAsks(source), `${file} asks for retired definitions: a record screen never shows one`).toEqual([]);
    }
    for (const { file, source } of webSources()) {
      expect(withoutComments(source), `${file} imports test support`).not.toMatch(/from ['"][^'"]*(tests\/e2e|custom-values-mock|custom-fields-mock|@kasuwa\/testing)[^'"]*['"]/);
    }
  });

  it('builds the custom filters in the contract’s shape, custom[key] and customEmpty, and never a custom sort', () => {
    const code = slice()
      .map(({ source }) => withoutComments(source))
      .join('\n');
    expect(code, 'nothing in the slice builds a custom[<key>] filter').toMatch(/custom\[/);
    expect(code, 'nothing in the slice builds a customEmpty filter').toMatch(/['"`]customEmpty['"`]/);
    expect(code, 'the slice builds a sort on a custom field').not.toMatch(/sort[^\n]{0,40}__c|__c[^\n]{0,40}sort/);
  });
});

// ===========================================================================
// 2. i18n — the lint rule, every catalogue, D-P1
// ===========================================================================

describe('acceptance: T-0091 — every string through i18n, in every catalogue, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on a slice file', () => {
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(
      /files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/,
    );
    // A rule only ever seen passing proves nothing: plant a literal at a slice file's own path.
    const target = slice().find(({ file }) => file.endsWith('.tsx'))?.file ?? 'apps/web/components/custom/planted.tsx';
    const planted = eslint(['--stdin', '--stdin-filename', target, '--format', 'json'], 'export default function Planted() {\n  return <p>Credit limit</p>;\n}\n');
    expect(planted.output, `a literal JSX string at ${target} is not rejected:\n${planted.output.slice(-2000)}`).toContain('i18next/no-literal-string');
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const files = slice();
    const run = eslint(['--max-warnings', '0', ...files.map(({ file }) => file)]);
    expect(run.status, `eslint fails on the custom-values slice:\n${run.output.slice(-4000)}`).toBe(0);
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of files.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('puts every message the slice names, the five refusals and the boolean’s yes and no, in every design-menu catalogue', async () => {
    const i18n: { DESIGN_MENU_LOCALES: readonly string[] } = await import(fromRoot('packages/i18n/src/index.ts'));
    const en = catalogue('en');
    const named = new Set<string>();
    for (const { source } of slice()) {
      for (const match of withoutComments(source).matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)) {
        if (match[1] !== undefined && en[match[1]] !== undefined) named.add(match[1]);
      }
    }
    // Vacuity guard: a slice that names almost no catalogue key is not using i18n.
    expect([...named].filter((id) => /custom/i.test(id)).length, 'the slice names almost no message id about custom fields').toBeGreaterThan(5);

    const find = (what: string, suffixes: readonly string[]): string => {
      const key = Object.keys(en).find((id) => /custom/i.test(id) && suffixes.some((suffix) => id.endsWith(suffix)));
      expect(key, `en.json has no label for ${what} (an id containing "custom" ending ${suffixes.join(' or ')})`).toBeDefined();
      return key ?? `<missing ${what}>`;
    };
    const required = [
      ...Object.entries(CUSTOM_CODES).map(([code, suffixes]) => find(code, suffixes)),
      find('the boolean true', ['.boolean.true', '.yes', '.true']),
      find('the boolean false', ['.boolean.false', '.no', '.false']),
    ];
    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const key of [...named, ...required]) {
        if (typeof messages[key] !== 'string' || messages[key].trim() === '') missing.push(`${locale}: ${key}`);
      }
    }
    expect(missing, 'message ids the custom-values slice uses that a catalogue lacks').toEqual([]);
    // A label that says the code is not a translation.
    for (const [code, suffixes] of Object.entries(CUSTOM_CODES)) {
      const key = find(code, suffixes);
      expect(en[key], `${key} just repeats the code`).not.toContain(code);
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
// 3. Colour, currency symbols, float money and the device
// ===========================================================================

describe('acceptance: T-0091 — no colour literal, no currency symbol, no float money, no device storage in the slice', () => {
  it('the detectors catch what they are for', () => {
    // Planted first: a detector only ever seen finding nothing proves nothing.
    // Passes before the work starts, by design.
    for (const planted of ['className="text-[#c00] p-2"', "style={{ color: 'red' }}", 'className="bg-sky-100"', 'className="border-white"']) {
      expect(colourLiterals(planted), `the colour detector missed ${planted}`).not.toEqual([]);
    }
    expect(colourLiterals('className="bg-surface text-text-2 border-border-strong"')).toEqual([]);
    for (const planted of ["const sign = '₦';", 'return `GH₵ ${amount}`;', "label = 'KSh ' + value;", "prefix: 'R'"]) {
      expect(currencySymbols(planted), `the currency-symbol detector missed ${planted}`).not.toEqual([]);
    }
    expect(currencySymbols("new Intl.NumberFormat(locale, { style: 'currency', currency: field.config.currencyCode })")).toEqual([]);
    for (const planted of [
      'const major = parseFloat(input);',
      'const minor = Number(value.amountMinor);',
      'const shown = amount / 100;',
      'Math.round(major * 100)',
      'total.toFixed(2)',
      'Number(amount)',
    ]) {
      expect(floatMoney(planted), `the float-money detector missed ${planted}`).not.toEqual([]);
    }
    expect(floatMoney('const minor = BigInt(whole) * 100n + BigInt(cents);')).toEqual([]);
    // The retired-definitions guard (D-L159) bites on a record-side module, however the truth is spelt.
    for (const planted of [
      "const url = `/api/v1/admin/custom-fields?object=${object}&includeRetired=true`;",
      "params.set('includeRetired', 'true');",
      "params.set('includeRetired', String(true));",
      'const query = { object, includeRetired: true };',
      'const query = { object, includeRetired: showAll };',
      'const query = { object, includeRetired };',
    ]) {
      expect(retiredAsks(planted), `the retired-definitions guard missed ${planted}`).not.toEqual([]);
    }
    for (const allowed of ["params.set('includeRetired', 'false');", 'const query = { object, includeRetired: false };', "fetch(`/api/v1/admin/custom-fields?object=${object}`)"]) {
      expect(retiredAsks(allowed), `the retired-definitions guard fired on ${allowed}`).toEqual([]);
    }
    // ... and never on the studio's own modules, which may ask for retired fields.
    expect(STUDIO_MODULES.every(studioModule)).toBe(true);
    expect(studioModule('apps/web/components/admin/custom-fields/studio-screen.tsx')).toBe(true);
    expect(studioModule('apps/web/lib/custom-values-api.ts'), 'the record-side client was excluded').toBe(false);
  });

  it('writes no colour literal anywhere in the slice', () => {
    const found = slice().flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the custom-values slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('types no currency symbol, and does no float arithmetic on an amount or a decimal (D-L128 Q6, CLAUDE.md 4)', () => {
    const files = slice();
    expect(files.flatMap(({ file, source }) => currencySymbols(source).map((hit) => `${file}: ${hit}`)), 'a hard-coded currency symbol').toEqual([]);
    expect(files.flatMap(({ file, source }) => floatMoney(source).map((hit) => `${file}: ${hit}`)), 'float arithmetic on money or a decimal').toEqual([]);
  });

  it('touches no device-storage API (D-P21)', () => {
    const storage = /\b(localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|navigator\.storage|document\.cookie)\b/;
    const found = [...slice(), ...definitionClients()].filter(({ source }) => storage.test(withoutComments(source))).map(({ file }) => file);
    expect(found, 'the custom-values slice uses a device-storage API').toEqual([]);
  });
});

// ===========================================================================
// 4. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0091 — the journeys and the mocks are the ones this suite was written with', () => {
  it('pins p18-custom-values.spec.ts, custom-values-mock.ts and the screen mocks that answer listCustomFields', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(normalisedHash(file), `${file} changed. It is part of the T-0091 acceptance contract: ask the lead to re-pin it.`).toBe(pinned);
    }
    const mock = readFileSync(fromRoot(CUSTOM_MOCK), 'utf8');
    expect(mock, 'the custom-field mock no longer reads the records contract').toContain('docs/api/records.openapi.yaml');
    expect(mock, 'the custom-field mock no longer reads the admin contract').toContain('docs/api/admin.openapi.yaml');
    expect(mock, 'the custom-field mock no longer checks its listCustomFields answers').toMatch(/schemaProblems\(body, LIST_SCHEMA/);
    for (const file of SCREEN_MOCKS) {
      const source = readFileSync(fromRoot(file), 'utf8');
      expect(source, `${file} no longer serves custom fields through custom-values-mock.ts`).toMatch(/from '\.\/custom-values-mock'/);
      expect(source, `${file} no longer answers listCustomFields`).toContain('custom.answerList(route)');
    }
  });
});

// ===========================================================================
// 5. The tag is this slice's alone (D-L84)
// ===========================================================================

describe('acceptance: T-0091 — @p18-custom-values selects these journeys and nothing else', () => {
  it('no other spec carries a tag @p18-custom-values matches, no other parent tag matches ours, and the spec carries only ours', () => {
    // Passes before the work starts: it guards later specs (T-0090's studio
    // among them) against colliding with this one, as `@p04` once collided
    // with `@p04-accounts`.
    const specs = trackedFiles('tests/e2e').filter((file) => file.endsWith('.spec.ts') && existsSync(fromRoot(file)));
    expect(specs).toContain(SPEC);
    // The parent-tag rule on planted tags: T-0090's studio (`@p18-studio`)
    // and ours share a `@p18-` prefix and must not collide either way; a bare
    // `@p18` parent would collide and must be caught.
    const studio = ['@p18-studio', '@p18-studio-list', '@p18-studio-create', '@p18-studio-retire'];
    expect(parentTag(studio)).toBe('@p18-studio');
    expect(new RegExp('@p18-studio').test(E2E_TAG), '@p18-studio would run these journeys').toBe(false);
    expect(studio.filter((tag) => new RegExp(E2E_TAG).test(tag))).toEqual([]);
    expect(new RegExp(parentTag(['@p18', '@p18-list']) ?? '(none)').test(E2E_TAG), 'a bare @p18 parent was not caught').toBe(true);
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
// 6. The browser — one run of @p18-custom-values
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0091 e2e run did not start', outcomes: undefined };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

function outcomes(): E2eOutcome[] {
  expect(e2eRun.outcomes, `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-6000)}`).toBeDefined();
  return e2eRun.outcomes ?? [];
}

describe('acceptance: T-0091 — custom values on the record screens in a browser', () => {
  beforeAll(() => {
    rmSync(OUTCOMES_FILE, { force: true });

    // Relative to tests/e2e, where run-e2e.mjs starts Playwright.
    const reporter = relative(fromRoot('tests', 'e2e'), fromRoot('tests', 'acceptance', 'support', 'e2e-outcomes-reporter.ts')).replace(/\\/g, '/');

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
    };
  }, E2E_RUN_TIMEOUT_MS);

  it('runs every @p18-custom-values journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(journeys.length, 'the run reported fewer @p18-custom-values tests than there are behaviours').toBeGreaterThanOrEqual(REQUIRED.length);
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p18-custom-values tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter((outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag));
      expect(proving.length, `no PASSING @p18-custom-values test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }
});
