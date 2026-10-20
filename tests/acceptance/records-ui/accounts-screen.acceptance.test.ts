import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
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
 * ACCEPTANCE — T-0057, the P04 Accounts screen (Agent 11, Frontend & Design
 * System). Decisions: D-L64, D-L69, D-L78, D-L80, D-P1, D-P13, D-P21.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. `crm_accounts`: a registered flag, DEFAULT OFF, NOT production-ready,
 *      read on the server through `lib/feature-flags.ts`. `/accounts` calls
 *      `notFound()` unless it is on, so the route is a real 404, not a hidden
 *      link. It is its own flag: gating `/accounts` on `crm_records` alone
 *      fails section 1.
 *   2. The e2e harness publishes `webAccountsUrl`: the SAME production build,
 *      `crm_accounts` in KASUWA_FEATURE_FLAGS_ON (NODE_ENV=test if the boot
 *      guard refuses a not-ready flag, as D-L64 ruled for `crm_records`). The
 *      default server stays flagless.
 *   3. The browser reads accounts same-origin (`/api/v1/accounts`), Zod-parsed,
 *      with no scope argument. `createAccount`'s TARGET `programmeId` is the
 *      one programme id a body may carry (the contract's rule 1).
 *   4. P04/03, 05 and 06 against the contract mock — columns, search, filters,
 *      sort, chooser, locks, paging, create, edit, refusals, the four states,
 *      offline in memory only, the hidden features, no UUID printed, 360 px,
 *      en-XA, D-P1 Beta badges and the byte budget — by e2e tag (section 5).
 *   5. i18n: the literal-string rule fires on the route; every message key the
 *      slice names is in every design-menu catalogue; each tier has a label in
 *      each; no design-menu language falls off the menu (D-P1).
 *   6. No colour literals in the slice — wider than the lint rule, which only
 *      sees a bare `'#rrggbb'` string — and no device-storage API.
 *
 * PINNED INTERFACES (the builder's side): the DOM hooks and the
 * `webAccountsUrl` stack key listed in the header of
 * `tests/e2e/p04-accounts.spec.ts`; the route file
 * `apps/web/app/(group)/accounts/page.tsx`; tier labels under a message id
 * ending `.tier.<code>` (any namespace) for each AccountTier code.
 *
 * BUILDER'S CHOICES: a fourth Next process or `crm_accounts` on the existing
 * `webRecordsUrl` process; table, cards or split view (P04/03 shows all
 * three); a sort menu or sortable headers; option lists or text inputs for the
 * free-valued filters (industry, tag, state, lga); whether a programme or a
 * parent account is shown at all (if it is, by name); where the account
 * client lives (`lib/records-api.ts` or a new `lib/*.ts`); the copy.
 *
 * NOT HELD HERE, AND WHY: "non-writers see no write controls". The contract
 * gives the screen no capability signal (`getCurrentUser` carries no
 * permissions by design; `listMyProgrammes` is closed at `{ id, name }`), so
 * no mock can serve a non-writer honestly. The spec carries it as a `fixme`
 * (`@p04-accounts-writers`) and REQUIRED below omits it, so a skipped test is
 * never read as coverage. It needs a contract decision first.
 *
 * THE BROWSER HALF. `tests/e2e/p04-accounts.spec.ts` (journeys) and
 * `tests/e2e/support/accounts-mock.ts` (the contract mock) were written with
 * this suite and are PINNED by hash below, because `tests/e2e` is not
 * path-protected (D-L64). ACCOUNTS_BUDGET_BYTES is the one line the builder
 * may change, and only downwards towards the measurement (section 5).
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p04-accounts --reporter=list,<ours>
 *
 * spawned with `shell: false` and the arguments as an array: one tag, no shell
 * metacharacter (D-L62). Every test is read from the outcomes file our
 * reporter writes, so a skipped, `fixme`d or unmatched test never counts.
 *
 * NOTE FOR THE LEAD: Playwright's --grep is a regular expression, so the
 * T-0042 suite's `--grep @p04` also runs every `@p04-accounts…` journey. Its
 * exit-code assertion therefore goes red until this screen passes, and stays
 * coupled to it afterwards.
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const FLAG = 'crm_accounts';

const E2E_TAG = '@p04-accounts';

/** `next build` (SWC wasm on the dev host, D-L62), a container, the servers and the journeys. */
const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p04-accounts.spec.ts';
const MOCK = 'tests/e2e/support/accounts-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/p04-accounts-budget.json';
const CONTRACT = 'docs/api/records.openapi.yaml';

/**
 * The pinned browser half (CRLF folded to LF; the budget literal normalised).
 * A change to either file is a change to the acceptance contract: the lead
 * re-pins it, the builder does not.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  [SPEC]: '78d4fb0f55738d8dd68e2ccf62c87d7844e0d8528d5f955d8678ac4b4847b4f4',
  // T-0091 (lead re-pin): the mock answers listCustomFields (empty unless a journey sets custom fields) and the custom filters.
  [MOCK]: '6da2ee53f6620bfd025cae52037130eb6546b101d2b0b6bf6461c87c8826ca04',
};

/**
 * See the budget test in the spec for the derivation. Never above this.
 * T-0125 lead re-pin (D-L189): the browser session's required cost on every
 * shell page (D-L187). c90db7e measured /accounts at 234,653 bytes
 * against the 235,000 pin; ACCOUNTS_BUDGET_BYTES moved to 237,000, about 1.0% over,
 * under this ceiling and inside the 5% rule. The spec's hash ignores the
 * budget literal, so it is not re-pinned.
 */
const ACCOUNTS_BUDGET_CEILING = 285_000; // D-L203: T-0145 measured, after removing the weight it could (no visual change)

/** Re-pinned within 5% of what the run measured, like /contacts (T-0042) and P01/1 (T-0035). */
const BUDGET_HEADROOM = 1.05;

const PRD_CEILING_BYTES = 300 * 1024;

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the mock's validators
  // reject malformed requests, so every afterEach "no violations" means something.
  ['@p04-accounts-mock', 'the contract mock refuses what the contract refuses'],
  ['@p04-accounts-flag-off', '/accounts is a 404 with crm_accounts at its default, and the browser cannot flip it'],
  ['@p04-accounts-flag-on', '/accounts renders with crm_accounts on'],
  ['@p04-accounts-shell', 'the CRM shell, Accounts current in its nav, no link a 404'],
  ['@p04-accounts-columns', 'the P04/03 columns, only Account properties, names not ids, markup as text, axe-clean'],
  ['@p04-accounts-search', 'name search sends q (at most 100), stays out of the URL and title'],
  ['@p04-accounts-filters', 'chips are the contract filter parameters, no live counts, field_withheld is an error'],
  ['@p04-accounts-sort', 'sort only by never-withheld keys; a new sort drops the cursor'],
  ['@p04-accounts-column-chooser', 'the column chooser hides and restores, offers only Account properties'],
  ['@p04-accounts-locked', 'a withheld field is a lock, per row, never empty; a null is never a lock'],
  ['@p04-accounts-paging', 'nextCursor paging, echoed exactly, kept out of the URL, no total'],
  ['@p04-accounts-create', 'create picks a programme by name, sends a contract body once, shows the account'],
  ['@p04-accounts-edit', 'edit sends the served version and no withheld field'],
  ['@p04-accounts-refusals', '403 and 409 are shown plainly, in translated copy, the sheet kept'],
  ['@p04-accounts-empty', 'P04/05 empty, offering create'],
  ['@p04-accounts-no-results', 'P04/05 no results, naming the search and the filter'],
  ['@p04-accounts-loading', 'P04/06 skeleton rows; a failed read is not "no accounts"'],
  ['@p04-accounts-offline', 'P04/06 offline: memory only, last synced, every edit disabled'],
  ['@p04-accounts-hidden', 'no Map, Health, bulk actions, rollups or DND marker'],
  ['@p04-accounts-mobile', '360 px: no sideways scroll, axe-clean'],
  ['@p04-accounts-pseudo', 'en-XA renders pseudo text on /accounts'],
  ['@p04-accounts-beta', 'the D-P1 Beta badges in the CRM shell language menu'],
  ['@p04-accounts-budget', '/accounts inside its byte budget on the production build'],
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

/** The App Router page for `/accounts` (a route group such as `(crm)` allowed). */
function accountsPage(): string | undefined {
  return trackedFiles('apps/web/app').find((file) =>
    /^apps\/web\/app\/(?:\([\w-]+\)\/)*accounts\/page\.tsx$/.test(file),
  );
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** apps/web modules that read or write `/api/v1/accounts`. */
function accountClients(): SourceFile[] {
  return webSources().filter(
    ({ file, source }) => file.startsWith('apps/web/lib/') && withoutComments(source).includes('/api/v1/accounts'),
  );
}

/** The slice: everything named for accounts (route, screen, model, client), plus the account client. */
function sliceSources(): SourceFile[] {
  const named = webSources().filter(
    ({ file }) => /(^|\/)accounts?(\/|[-.])/i.test(file.replace(/^apps\/web\//, '')) && !file.includes('[id]'),
  );
  const clients = accountClients().filter(({ file }) => !named.some((entry) => entry.file === file));
  return [...named, ...clients];
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8'),
  ) as Record<string, string>;
}

const BUDGET_LITERAL = /const ACCOUNTS_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(BUDGET_LITERAL, 'const ACCOUNTS_BUDGET_BYTES = <budget>;');
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

type Json = Record<string, unknown>;

/** Error `code`s an operation can answer with, from the contract's examples. */
function errorCodes(path: string, method: string): string[] {
  const contract = parse(readFileSync(fromRoot(CONTRACT), 'utf8')) as {
    paths: Record<string, Record<string, { responses: Record<string, { $ref?: string }> }>>;
    components: { responses: Record<string, Json> };
  };
  const operation = contract.paths[path]?.[method];
  expect(operation, `${method.toUpperCase()} ${path} is gone from the records contract`).toBeDefined();
  const codes = new Set<string>();
  for (const [status, response] of Object.entries(operation?.responses ?? {})) {
    if (status.startsWith('2') || typeof response.$ref !== 'string') {
      continue;
    }
    const name = response.$ref.split('/').at(-1) ?? '';
    const body = (contract.components.responses[name]?.content as Json | undefined)?.['application/json'] as
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

function accountTiers(): string[] {
  const contract = parse(readFileSync(fromRoot(CONTRACT), 'utf8')) as {
    components: { schemas: { AccountTier?: { enum?: string[] } } };
  };
  return contract.components.schemas.AccountTier?.enum ?? [];
}

/**
 * Colour written into a web source rather than read from a token: a hex value
 * anywhere in a string (`'text-[#c00]'` gets past the lint rule, which only
 * matches a string that IS a hex value), a CSS colour function, a Tailwind
 * arbitrary colour, or a Tailwind default-palette class (the preset EXTENDS
 * the palette, so `bg-red-500` compiles, and bypasses every token).
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

describe('acceptance: T-0057 — crm_accounts exists, is off, is not production-ready, and gates /accounts', () => {
  it('registers crm_accounts, not production-ready, and it evaluates OFF by default', async () => {
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

  it('is read through lib/feature-flags.ts and never by a client module; /accounts calls notFound() on crm_accounts', () => {
    const flagModule = withoutComments(readFileSync(fromRoot('apps/web/lib/feature-flags.ts'), 'utf8'));
    const named = new RegExp(`['"]${FLAG}['"]`);
    const clientEvaluators = webSources().filter(
      ({ source }) => /^\s*['"]use client['"]/m.test(source) && source.includes(FLAG),
    );
    expect(
      clientEvaluators.map(({ file }) => file),
      'a client module names crm_accounts — flags are read on the server only',
    ).toEqual([]);

    // The exported readers whose body evaluates crm_accounts by name.
    const readers = [...flagModule.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)]
      .filter((match) => named.test(match[2] ?? ''))
      .map((match) => match[1] ?? '');

    const page = accountsPage();
    expect(page, 'there is no apps/web/app/**/accounts/page.tsx').toBeDefined();
    const source = withoutComments(readFileSync(fromRoot(page ?? 'missing'), 'utf8'));
    // A gated ROUTE, not a hidden link: the page itself answers 404 — on ITS
    // flag. Either a dedicated reader (`crmAccountsEnabled()`, as crm_records
    // has) or a generic one called with the flag's name; never crm_records alone.
    expect(source, `${page} does not call notFound()`).toMatch(/\bnotFound\s*\(/);
    expect(source, `${page} imports nothing from lib/feature-flags`).toMatch(/from ['"][./]*lib\/feature-flags['"]/);
    const gated = readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source)) || named.test(source);
    expect(gated, `${page} is not gated on crm_accounts (readers found: ${readers.join(', ') || 'none'})`).toBe(true);
  });

  it('starts a crm_accounts web process, publishes webAccountsUrl, and leaves the default server flagless', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    expect(runner, 'run-e2e.mjs starts no web process with crm_accounts in KASUWA_FEATURE_FLAGS_ON').toMatch(
      /KASUWA_FEATURE_FLAGS_ON:\s*['"`][^'"`]*\bcrm_accounts\b/,
    );
    expect(runner, 'run-e2e.mjs does not publish webAccountsUrl in the stack file').toContain('webAccountsUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(
      /KASUWA_FEATURE_FLAGS_ON:\s*''/,
    );
  });

  it('reads and writes accounts same-origin, Zod-parsed, with no scope argument', () => {
    const clients = accountClients();
    expect(clients.map(({ file }) => file), 'no apps/web/lib module calls /api/v1/accounts').not.toEqual([]);
    for (const { file, source } of clients) {
      const code = withoutComments(source);
      expect(code, `${file} does not use a relative /api/v1/accounts path`).toMatch(/['"`]\/api\/v1\/accounts['"`/?]/);
      expect(code, `${file} names an absolute API origin`).not.toMatch(/https?:\/\/[^'"`]*\/api\/v1/);
      expect(code, `${file} does not parse with Zod`).toMatch(/from ['"]zod['"]/);
      // createAccount's TARGET programmeId is a body property; a programme in a
      // query string, a header or a list of them is scope from the client.
      expect(code, `${file} builds a scope argument`).not.toMatch(
        /programmeIds|(set|append)\(\s*['"`]programme|['"`]x-[\w-]*programme/i,
      );
    }
    for (const { file: name, source: code } of webSources()) {
      expect(withoutComments(code), `${name} imports test support`).not.toMatch(
        /from ['"][^'"]*(tests\/e2e|accounts-mock|records-mock|@kasuwa\/testing)[^'"]*['"]/,
      );
    }
  });
});

// ===========================================================================
// 2. i18n — the lint rule, every catalogue, D-P1
// ===========================================================================

describe('acceptance: T-0057 — every string through i18n, in every catalogue, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the /accounts route file', () => {
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(
      /files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/,
    );
    // A rule only ever seen passing proves nothing. Plant a literal at the
    // route's own path and watch it fail.
    const page = accountsPage();
    expect(page, 'there is no apps/web/app/**/accounts/page.tsx').toBeDefined();
    const planted = eslint(
      ['--stdin', '--stdin-filename', page ?? 'apps/web/app/accounts/page.tsx', '--format', 'json'],
      'export default function Planted() {\n  return <p>All accounts</p>;\n}\n',
    );
    expect(planted.output, `a literal JSX string at ${page} is not rejected:\n${planted.output.slice(-2000)}`).toContain(
      'i18next/no-literal-string',
    );
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const slice = sliceSources();
    const files = slice.map(({ file }) => file);
    expect(files, 'no apps/web file for the accounts slice (route, screen, account client)').toContain(
      accountsPage() ?? 'apps/web/app/accounts/page.tsx',
    );
    const run = eslint(['--max-warnings', '0', ...files]);
    expect(run.status, `eslint fails on the accounts slice:\n${run.output.slice(-4000)}`).toBe(0);

    // jsx-text-only cannot see attributes; an English aria-label is still English.
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('puts every message the slice names, and a label for each tier, in every design-menu catalogue', async () => {
    const i18n: { DESIGN_MENU_LOCALES: readonly string[] } = await import(fromRoot('packages/i18n/src/index.ts'));
    const en = catalogue('en');
    const slice = sliceSources();
    expect(slice.length, 'there is no accounts slice to read message ids from').toBeGreaterThan(0);

    const named = new Set<string>();
    for (const { source } of slice) {
      for (const match of withoutComments(source).matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)) {
        if (match[1] !== undefined && en[match[1]] !== undefined) {
          named.add(match[1]);
        }
      }
    }
    // Vacuity guard: a slice that names no catalogue key is not using i18n.
    expect(named.size, 'the accounts slice names no message id at all').toBeGreaterThan(5);

    const tierKeys = accountTiers().map((tier) => {
      const key = Object.keys(en).find((id) => id.endsWith(`.tier.${tier}`));
      expect(key, `en.json has no label for the ${tier} tier (a message id ending ".tier.${tier}")`).toBeDefined();
      return key ?? `<missing>.tier.${tier}`;
    });
    expect(tierKeys.length, 'the contract lists no tiers').toBeGreaterThan(0);

    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const key of [...named, ...tierKeys]) {
        if (typeof messages[key] !== 'string' || messages[key].trim() === '') {
          missing.push(`${locale}: ${key}`);
        }
      }
    }
    expect(missing, 'message ids the accounts screen uses that a catalogue lacks').toEqual([]);
  });

  it('localises every error the account operations can answer with', () => {
    // NOTE: passes before the work starts — T-0042 already added records.error.*
    // for every shared code. It is here so a new code in the contract (or a
    // dropped key) fails this suite rather than reaching a user as a raw code.
    const en = catalogue('en');
    const codes = new Set([
      ...errorCodes('/api/v1/accounts', 'get'),
      ...errorCodes('/api/v1/accounts', 'post'),
      ...errorCodes('/api/v1/accounts/{accountId}', 'patch'),
    ]);
    expect([...codes], 'the account operations declare no error codes').toEqual(
      expect.arrayContaining(['not_permitted', 'stale_write', 'validation_failed']),
    );
    const missing = [...codes].filter((code) => en[`records.error.${code}`] === undefined);
    expect(missing, 'en.json lacks records.error.<code> for these account errors').toEqual([]);
  });

  it('drops no design-menu language from the menu (D-P1)', async () => {
    // New English keys make every draft catalogue incomplete, and an incomplete
    // language silently leaves MENU_LOCALES — taking its Beta badge with it.
    // The browser test counts badges against BETA_LOCALES, which would shrink
    // in step and pass; this is the check that cannot. (It passes before the
    // work starts, too: it guards against the work, not for it.)
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

describe('acceptance: T-0057 — no colour literal and no device storage in the slice', () => {
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

  it('writes no colour literal anywhere in the slice', () => {
    const slice = sliceSources();
    expect(slice.length, 'there is no accounts slice to check').toBeGreaterThan(0);
    const found = slice.flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the accounts slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('touches no device-storage API (D-L64, D-P21)', () => {
    const slice = sliceSources();
    expect(slice.length, 'there is no accounts slice to check').toBeGreaterThan(0);
    const storage = /\b(localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|navigator\.storage|document\.cookie)\b/;
    const found = slice.filter(({ source }) => storage.test(withoutComments(source))).map(({ file }) => file);
    expect(found, 'the accounts slice uses a device-storage API: the list lives in memory only').toEqual([]);
  });
});

// ===========================================================================
// 4. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0057 — the journeys and the mock are the ones this suite was written with', () => {
  it('pins p04-accounts.spec.ts and accounts-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(
        normalisedHash(file),
        `${file} changed. It is part of the T-0057 acceptance contract: ask the lead to re-pin it ` +
          '(only ACCOUNTS_BUDGET_BYTES may move without that).',
      ).toBe(pinned);
    }
    expect(readFileSync(fromRoot(MOCK), 'utf8'), 'the mock no longer reads the records contract').toContain(CONTRACT);
  });
});

// ===========================================================================
// 5. The browser — one run of @p04-accounts
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0057 e2e run did not start', outcomes: undefined, startedAt: 0 };

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

describe('acceptance: T-0057 — the accounts screen in a browser', () => {
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

  it('runs every @p04-accounts journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(journeys.length, 'the run reported fewer @p04-accounts tests than there are behaviours').toBeGreaterThanOrEqual(
      REQUIRED.length,
    );
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p04-accounts tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter(
        (outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag),
      );
      expect(proving.length, `no PASSING @p04-accounts test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('pins /accounts at or under 245,000 bytes and within 5% of what this run measured', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'ACCOUNTS_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /accounts budget is above its ceiling').toBeLessThanOrEqual(ACCOUNTS_BUDGET_CEILING);
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
      `the budget is more than 5% over the ${measured} bytes measured — re-pin ACCOUNTS_BUDGET_BYTES`,
    ).toBeLessThanOrEqual(Math.round(measured * BUDGET_HEADROOM));
  });
});
