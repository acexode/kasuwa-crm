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
 * ACCEPTANCE — T-0090, the P18 customisation studio for custom fields (Agent
 * 11, Frontend & Design System), against T-0088's admin contract as served
 * since T-0089 (`listCustomFields`, `createCustomField`, `updateCustomField`,
 * `retireCustomField`). Decisions: ADR-0016, D-L128, D-L138, D-L139, D-L140,
 * D-L141, D-L142, D-L143, D-L45, D-L53, D-L84, D-P24, D-P25.
 * Written by the lead's QA agent before the screen exists (D-L23).
 *
 * WHY admin-ui AND NOT records-ui. The studio is a tenant-admin tool in the
 * admin console: its operations are in `admin.openapi.yaml` (each names its
 * `x-kasuwa-screens` P18/B, B1, B2); every write needs `custom_field.write`,
 * the tenant-admin flag (D-L53); a definition is tenant-wide and never
 * programme-scoped (ADR-0008), so it has no place in the CRM shell's
 * programme-scoped world; the P02 settings menu already carries its entry
 * ("Fields", `cu-fields`, under Customisation, `components/admin/nav-model.ts`);
 * and the design's header is the console's ("Admin", "Tenant administrator").
 * The task file's "like every records-ui screen" is honoured by holding the
 * screen to the same checks: a pinned byte budget, axe, 360 px and en-XA.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. `crm_custom_fields`: a registered flag, DEFAULT OFF, NOT
 *      production-ready, read on the server through `lib/feature-flags.ts`.
 *      `/admin/custom-fields` calls `notFound()` and is gated on it by name,
 *      so with every flag at its default it is a real 404 and no admin screen
 *      links to it. No client module names it.
 *   2. The e2e harness publishes `webStudioUrl`; `crm_custom_fields` RIDES ON
 *      THE RECORDS PROCESS (the one production build with flags on).
 *   3. The browser calls the four operations same-origin, Zod-parsed, with no
 *      scope argument, from an `apps/web/lib` module.
 *   4. The studio against the contract mock, and once against the real API,
 *      by e2e tag (section 6): the flag and the menu entry; the four objects;
 *      the list, retired fields and the limits; create, the api-name rule,
 *      the six types and their config, the classification and its defaults;
 *      edit, locked type, api name and currency, and the raise warning;
 *      retire with a confirmation; every error localised; the 403 gate; the
 *      keyboard, axe, 360 px and en-XA; the overruled design absent; the
 *      budget.
 *   5. i18n: the literal-string rule fires on the route; every message id the
 *      slice names, and the labels the journeys look for, are in every
 *      design-menu catalogue; every error code the four operations answer is
 *      localised (`admin.error.limit_reached` is new); no language falls off
 *      the menu.
 *   6. No colour literal and no spacing literal in the slice (wider than the
 *      lint rule, D-L84).
 *
 * PINNED INTERFACES (the builder's side)
 *
 *   - The DOM hooks and the `webStudioUrl` stack key in the header of
 *     `tests/e2e/p18-studio.spec.ts`.
 *   - The route file `apps/web/app/admin/custom-fields/page.tsx`, holding a
 *     P18 screen (`data-screen="P18/B"`) and a field form
 *     (`data-testid="field-form"`).
 *   - An `apps/web/lib` module naming `/api/v1/admin/custom-fields` that
 *     parses the list's `limits` (it names `fieldsPerObject`) and asks for
 *     retired fields by `includeRetired`.
 *   - Labels under ids containing `custom` or `studio`, ending
 *     `.type.<text|number|currency|date|picklist|boolean>`,
 *     `.object.<contact|account|activity|deal>`, `.retired`,
 *     `.classification_default` (or `.classificationDefault`, R14),
 *     `.classification_raised` (or `.classificationRaised`, R15), and
 *     `.<detail>` for every `details[].code` the custom-field responses
 *     declare (R17); a classification label for pii and sensitive under any
 *     id ending `.class.<level>` or `.classification.<level>` (the P02
 *     matrix's `admin.fls.class.*` qualify); `admin.error.<code>` for every
 *     error code of the four operations.
 *
 * RULINGS (R1–R25; where the task file, the contract or the design leave a
 * choice open, the suite is written to these)
 *
 *   R1. Placement: the admin console (above). One route,
 *       `/admin/custom-fields`, inside the admin shell, with the settings
 *       menu's `cu-fields` entry current. The create and edit forms are one
 *       `<form>` (`data-mode`), a sheet, a dialog or inline: builder's choice.
 *   R2. Flag. `crm_custom_fields` (the lead's name). It gates the route and the
 *       menu entry; it grants nothing (the API decides access). T-0091's task
 *       file speaks of "the custom-fields flag": whether the record screens
 *       share it is T-0091's suite's ruling, and nothing here forbids it.
 *   R3. Harness. NOT WIRED BY THIS SUITE: the builder adds
 *       `crm_custom_fields` to the records process and `webStudioUrl` to the
 *       stack file in the change that registers the flag. Naming an
 *       unregistered flag in KASUWA_FEATURE_FLAGS_ON stops a web process
 *       booting, which would take every records-process suite down on main.
 *   R4. Menu. The P02 menu's `cu-fields` entry is a link to
 *       `/admin/custom-fields` only where the flag is on (current on the
 *       studio), and stays a non-link where it is off. The default server and
 *       the records process each serve one half, so both are held in the
 *       browser. How the shell learns it (a prop from the server pages, as
 *       `crmLiveNav()` does for the CRM shell) is the builder's choice.
 *   R5. Objects. One control per standard object, exactly the contract's four
 *       in its order, contact shown first; switching reads
 *       `listCustomFields?object=<object>`; an object with no field says so.
 *       A lead is a contact (D-P17): no separate lead control.
 *   R6. List. Active fields by default, in the served (api name) order, each
 *       with its label, api name, a translated type label and, for pii and
 *       sensitive, a translated classification label. Labels, api names and
 *       descriptions are tenant data (`data-record-text`); markup is text.
 *       Never a usage or record count (the contract serves none).
 *   R7. Retired. Listed only while a "show retired" control is on, marked
 *       retired, with no edit or retire control: read-only. No restore.
 *       Whether the studio reads `includeRetired=true` always and filters, or
 *       only on request, is the builder's choice.
 *   R8. Limits. The active count and `limits.fieldsPerObject` are shown, read
 *       from the list. At the limit the studio either offers no create and
 *       says why, or draws the API's 409 by its detail label; the same for a
 *       full picklist. The label input has maxlength 255, the api name 63.
 *   R9. Create. The closed body, only the contract's fields; classification
 *       defaults to none; `config` only for picklist (`values`) and currency
 *       (`currencyCode`), never on the other four (`{}` included). The type
 *       control offers exactly the six types; no refused type is offered. The
 *       currency control offers exactly NGN, GHS, KES and ZAR.
 *   R10. Api name (D-P24). Validated against `^[a-z][a-z0-9_]*__c$` and
 *       4..63 characters BEFORE sending: an invalid one is marked
 *       `aria-invalid`, its error announced through `aria-describedby`, and
 *       nothing is sent. A suggestion from the label is allowed and must
 *       obey the rule. A taken name, live or retired, is drawn by the
 *       `.duplicate` label, whether checked first or answered 409.
 *   R11. Picklist values. Each `value` is well formed and unique; whether it
 *       is derived from the label or typed (`data-part="value"`) is the
 *       builder's choice. A picklist with no value is never sent.
 *   R12. A successful save closes the form and the list shows the change. A
 *       double click on save sends one write.
 *   R13. Edit. Only `label`, `description`, `classification`, `addValues`
 *       and `relabelValues`, and only what the admin changed (the audit names
 *       what changed, by key). Type, api name and the currency are shown and
 *       never editable. An existing picklist value's row holds no button:
 *       values are never removed or reordered.
 *   R14. The create defaults (D-L128 Q2). Choosing pii or sensitive on create
 *       shows a note that other permission sets start with no access.
 *   R15. The raise warning (D-L140). Raising a classification on edit (none
 *       to pii or sensitive, pii to sensitive) shows a warning that existing
 *       access is unchanged, because reclassifying never rewrites the matrix;
 *       it goes when the change is undone. Lowering: builder's choice.
 *   R16. Retire. A confirmation dialog (`role` dialog or alertdialog,
 *       `aria-modal`, labelled) naming the field; Escape and cancel send
 *       nothing and return focus to the control that opened it; confirm sends
 *       one POST with no body. The word is retire, never delete.
 *   R17. Errors. Every error example the three writes declare, and a dropped
 *       connection, is drawn localised: a custom-field `details[].code` by its
 *       own studio label, otherwise `admin.error.<code>`; never the raw code
 *       or the contract's English `message`. The draft survives, except after
 *       a 404 or `field_retired`, when the form may close.
 *       (`admin.error.duplicate_code` speaks of a disposition: the detail
 *       label is what the studio draws.)
 *   R18. Who may write (D-L84). No operation tells the screen whether the
 *       caller holds `custom_field.write` (T-0079, the capability read, is
 *       not built), so write controls show to every caller and the API's 403
 *       is the gate, drawn as a translated `role="alert"` that keeps the
 *       draft. The list needs no permission. Hiding the controls from
 *       non-writers waits on T-0079 (`@p18-studio-writers`, a fixme).
 *   R19. Scope is the session's (CLAUDE.md 2.2): no programme, tenant or
 *       scope header or parameter; same-origin relative paths; Zod.
 *   R20. i18n as section 2; no English in a user-facing attribute.
 *   R21. Tokens. No colour literal and no spacing literal (an arbitrary
 *       Tailwind length or an inline style length) in the slice: the
 *       `/admin/custom-fields` route directory and everything it imports by a
 *       relative path, transitively, except the auth shell.
 *   R22. Accessibility: the create form opens by keyboard with focus inside;
 *       Enter submits it; invalid controls are `aria-invalid` with
 *       `aria-describedby`; the dialog traps focus and gives it back; axe is
 *       clean on the list, both forms, a refusal, the warning and the dialog,
 *       and at 360 px, where nothing scrolls sideways.
 *   R23. Absent (the design's items the contract or the task overrules):
 *       custom objects, relationships, layouts, validation rules and record
 *       types; delete and restore; a type change; "Used in" and unused-field
 *       counts; plan meters; currencies beyond the four; text length, number
 *       decimals and range, default values, help-text translations,
 *       "required on this layout", encrypted ID fields, the filterable meter.
 *       Read on the studio's own surfaces (its screen, form and dialog), not
 *       the whole page: the P02 menu's unbuilt Customisation entries stay
 *       aria-disabled and announced (lead edit, T-0090, D-L145).
 *   R24. Budget. STUDIO_BUDGET_BYTES = 266,000, pinned by the lead (T-0090,
 *       D-L145) from the builder's runs (259,164 and 259,660 bytes on the final
 *       code; 259,876 and 260,023 earlier). The ceiling is 270,000. The suite
 *       requires the budget to be at least, and within 5% of, what each run
 *       measures (D-L118).
 *   R25. Live. One journey drives the real API through the studio: the seed's
 *       tenant administrator creates, relabels and retires a `none` deal
 *       field unique to the run, and an agent's create is refused 403.
 *
 * BUILDER'S CHOICES: the layout; select or radio group for type,
 * classification and currency; whether the api name is suggested; how a
 * picklist value is derived; when retired fields are read; whether a full
 * object hides or disables create; whether lowering a classification warns;
 * the copy.
 *
 * NOT HELD HERE, AND WHY
 *   - The field-security matrix (P02/D) is not edited from the studio; a link
 *     to it is allowed and, like every link, must not 404.
 *   - Concurrency: `updateCustomField` carries no version, so there is no
 *     stale-write state to draw.
 *
 * THE BROWSER HALF. `tests/e2e/p18-studio.spec.ts` (journeys) and
 * `tests/e2e/support/custom-fields-mock.ts` (the contract mock, which checks
 * every request and every answer against the YAML) were written with this
 * suite and are PINNED by hash below, because `tests/e2e` is not
 * path-protected (D-L64). STUDIO_BUDGET_BYTES is the one line that may change
 * without a re-pin.
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p18-studio --reporter=list,<ours>
 *
 * spawned with `shell: false` and the arguments as an array (D-L62). Every
 * test is read from the outcomes file our reporter writes, so a skipped,
 * `fixme`d or unmatched test never counts. No other spec's tag contains
 * `@p18-studio`, and it contains no other screen's parent tag (section 5).
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const FLAG = 'crm_custom_fields';
/** The flags of the records process that `crm_custom_fields` rides on. */
const RECORDS_PROCESS_FLAGS = ['crm_records', 'crm_accounts', 'crm_record_view', 'crm_leads'];

const E2E_TAG = '@p18-studio';

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
  '@p27-search',
  '@harness',
  '@budget',
  '@byte-budget',
  '@fonts',
  '@locale-beta',
];

/** `next build`, a container, the servers and the journeys. */
const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p18-studio.spec.ts';
const MOCK = 'tests/e2e/support/custom-fields-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/p18-studio-budget.json';
const CONTRACT = 'docs/api/admin.openapi.yaml';
const STUDIO_PATH = '/api/v1/admin/custom-fields';
const ROUTE_FILE = 'apps/web/app/admin/custom-fields/page.tsx';

/**
 * The pinned browser half (CRLF folded to LF; the budget literal normalised).
 * A change to either file is a change to the acceptance contract: the lead
 * re-pins it, the builder does not.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  // Lead re-pin (T-0090, D-L145): the mock serves the P02 home's three reads; @p18-studio-absent reads the
  // studio's own surfaces, not the whole body; the budget is pinned at 266,000 (R24).
  [SPEC]: '2b561359870951d45b5b0979dbefb085a0f89114b39391dab8479e748d29fee9',
  [MOCK]: 'eedc52ce90be2c2ba09478daa4de7e885819419b2f0c31aa789383416d61fdd1',
};

/** Never above this (R24). */
const STUDIO_BUDGET_CEILING = 270_000;

/** Pinned within 5% of what the run measured (D-L118). */
const BUDGET_HEADROOM = 1.05;

const PRD_CEILING_BYTES = 300 * 1024;

/** The operations the studio calls, for the error-localisation check. */
const OPERATIONS: readonly (readonly [path: string, method: string])[] = [
  [STUDIO_PATH, 'get'],
  [STUDIO_PATH, 'post'],
  [`${STUDIO_PATH}/{fieldId}`, 'patch'],
  [`${STUDIO_PATH}/{fieldId}/retire`, 'post'],
];

const TYPES = ['text', 'number', 'currency', 'date', 'picklist', 'boolean'] as const;
const OBJECTS = ['contact', 'account', 'activity', 'deal'] as const;

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the mock's validators
  // reject malformed requests and answers, so every afterEach "no violations"
  // and "no mock faults" means something.
  ['@p18-studio-mock', 'the contract mock refuses what the contract and the studio’s rules refuse, and checks its own answers'],
  // Passes before the work starts too (no route, an unlinked menu entry): a
  // negative invariant, given meaning by @p18-studio-flag-on and -shell.
  ['@p18-studio-flag-off', '/admin/custom-fields is a 404 with the flag at its default, unlinked, and the browser cannot flip it'],
  ['@p18-studio-flag-on', '/admin/custom-fields renders the P18 studio with crm_custom_fields on'],
  ['@p18-studio-shell', 'the studio sits in the admin shell; the Fields entry links it where the flag is on; no link a 404'],
  ['@p18-studio-objects', 'exactly the four objects, contact first, each listing only its own fields; an empty state'],
  ['@p18-studio-list', 'active fields in the served order with label, api name, translated type and classification; markup as text'],
  ['@p18-studio-retired', 'retired fields only on request, marked retired, read-only'],
  ['@p18-studio-limits', 'the active count and the limit shown; the field and picklist limits enforced or drawn'],
  ['@p18-studio-create', 'a create sends exactly what was typed, closes, lists the field; a double click sends one'],
  ['@p18-studio-api-name', 'the __c rule enforced before sending, announced; a taken name, live or retired, refused by name'],
  ['@p18-studio-types', 'exactly the six types; picklist values and one of four currencies; no config on the others'],
  ['@p18-studio-classification', 'none, pii, sensitive, default none; pii and sensitive say other sets start at no access'],
  ['@p18-studio-edit', 'only what changed is sent; values added or relabelled, never removed; type, api name, currency locked'],
  ['@p18-studio-raise-warning', 'raising a classification warns that existing access is unchanged (D-L140)'],
  ['@p18-studio-retire', 'retire asks in a labelled modal dialog; cancel sends nothing; the field then shows retired, read-only'],
  ['@p18-studio-errors', 'every error the writes can answer, and a dropped connection, drawn localised; the draft kept'],
  ['@p18-studio-not-permitted', 'without custom_field.write the list reads and every write is refused as a translated alert (D-L84)'],
  ['@p18-studio-keyboard', 'keyboard opening and submitting; errors announced; the dialog traps and returns focus'],
  ['@p18-studio-axe', 'axe-clean list, forms, refusal, warning and dialog'],
  ['@p18-studio-absent', 'no custom objects, layouts, rules, delete, restore, type change, usage, plans or extra currencies'],
  ['@p18-studio-mobile', '360 px: no sideways scroll, axe-clean, the form usable'],
  ['@p18-studio-pseudo', 'en-XA renders pseudo text on the studio, its forms and its dialog'],
  ['@p18-studio-live', 'the real API: the seeded admin creates, relabels and retires; an agent is refused'],
  ['@p18-studio-budget', '/admin/custom-fields inside its byte budget on the production build'],
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

/** The auth shell is held by the P01 suites and carries the language menu's cookie; not part of this slice. */
const OTHER_SHELLS = ['apps/web/components/auth/'];

/** The slice: the route directory and everything it imports by a relative path, transitively, minus the auth shell. */
function sliceSources(): SourceFile[] {
  if (!existsSync(fromRoot(ROUTE_FILE))) {
    return [];
  }
  const sources = new Map(webSources().map((entry) => [entry.file, entry.source]));
  const routeDirectory = posix.dirname(ROUTE_FILE);
  const queue = [...sources.keys()].filter((file) => file.startsWith(`${routeDirectory}/`));
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

/** The slice, refused unless the route exists and it contains the P18 screen and the field form. */
function screenSlice(): SourceFile[] {
  expect(existsSync(fromRoot(ROUTE_FILE)), `there is no ${ROUTE_FILE}`).toBe(true);
  const slice = sliceSources();
  expect(
    slice.filter(({ source }) => /['"`]P18\/B['"`]/.test(withoutComments(source))).map(({ file }) => file),
    'the /admin/custom-fields route imports no P18 screen (data-screen="P18/B")',
  ).not.toEqual([]);
  expect(
    slice.filter(({ source }) => /['"`]field-form['"`]/.test(withoutComments(source))).map(({ file }) => file),
    'nothing the route imports is the field form (data-testid="field-form")',
  ).not.toEqual([]);
  return slice;
}

/** apps/web/lib modules that call the custom-field operations. */
function studioClients(): SourceFile[] {
  return webSources().filter(({ file, source }) => file.startsWith('apps/web/lib/') && withoutComments(source).includes(STUDIO_PATH));
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8')) as Record<string, string>;
}

const BUDGET_LITERAL = /const STUDIO_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(BUDGET_LITERAL, 'const STUDIO_BUDGET_BYTES = <budget>;');
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

/** The `code`s and `details[].code`s an operation can answer with, from the contract's examples. */
function errorCodes(path: string, method: string): { codes: string[]; details: string[] } {
  const spec = contract();
  const operation = spec.paths[path]?.[method];
  expect(operation, `${method.toUpperCase()} ${path} is gone from the admin contract`).toBeDefined();
  const codes = new Set<string>();
  const details = new Set<string>();
  for (const [status, response] of Object.entries(operation?.responses ?? {})) {
    if (status.startsWith('2') || typeof response.$ref !== 'string') {
      continue;
    }
    const name = response.$ref.split('/').at(-1) ?? '';
    const body = (spec.components.responses[name]?.content as Json | undefined)?.['application/json'] as
      | { example?: { code?: string; details?: { code?: string }[] }; examples?: Record<string, { value?: { code?: string; details?: { code?: string }[] } }> }
      | undefined;
    for (const example of [body?.example, ...Object.values(body?.examples ?? {}).map((entry) => entry.value)]) {
      if (typeof example?.code === 'string') codes.add(example.code);
      for (const detail of example?.details ?? []) {
        if (typeof detail.code === 'string') details.add(detail.code);
      }
    }
  }
  return { codes: [...codes].sort(), details: [...details].sort() };
}

/** The custom-field detail codes: the ones a custom-field write can answer that the generic envelopes do not. */
function customFieldDetailCodes(): string[] {
  const details = new Set<string>();
  for (const [path, method] of OPERATIONS.slice(1)) {
    for (const code of errorCodes(path, method).details) details.add(code);
  }
  return [...details].sort();
}

/**
 * Colour written into a web source rather than read from a token: a hex value
 * anywhere in a string, a CSS colour function, a Tailwind arbitrary colour, a
 * Tailwind default-palette class, or an inline style colour (D-L84).
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
 * A spacing or size written as a literal rather than read from the scale: a
 * Tailwind arbitrary length on a spacing or sizing utility (`p-[13px]`,
 * `w-[220px]`, `gap-[0.3rem]`), or an inline style length
 * (`style={{ padding: 12 }}`, `marginTop: '4px'`). `var(--…)` stays allowed.
 */
function spacingLiterals(source: string): string[] {
  const code = withoutComments(source);
  const patterns = [
    /(?<![\w-])-?(?:p|px|py|pt|pb|ps|pe|pl|pr|m|mx|my|mt|mb|ms|me|ml|mr|gap|gap-x|gap-y|space-x|space-y|w|h|size|min-w|min-h|max-w|max-h|top|bottom|left|right|inset|inset-x|inset-y|start|end|basis|indent|leading|tracking)-\[(?!var\()[^\]]*\d[^\]]*\]/g,
    // Inside a `style={{ … }}` only, so `scrollTo({ top: 0 })` is not a spacing literal.
    /\bstyle=\{\{[^}]*?\b(?:padding|margin|gap|rowGap|columnGap|width|height|minWidth|minHeight|maxWidth|maxHeight|top|left|right|bottom|inset|insetInlineStart|insetInlineEnd)(?:Top|Bottom|Left|Right|Inline|Block|InlineStart|InlineEnd|BlockStart|BlockEnd)?\s*:\s*['"`]?-?\d/g,
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

/** The test tags in a spec's code (titles and annotations), comments and package scopes excluded. */
function tagsIn(file: string): string[] {
  return [...withoutComments(readFileSync(fromRoot(file), 'utf8')).matchAll(/@[a-z0-9][\w-]*/gi)]
    .map((match) => match[0])
    .filter((tag) => /^@(p\d|leads|harness|budget|byte-budget|fonts|locale-beta)/i.test(tag));
}

/** en.json ids about the studio (`custom` or `studio`) ending with one of `suffixes`. */
function studioKey(en: Record<string, string>, suffixes: readonly string[]): string | undefined {
  return Object.keys(en).find((id) => /custom|studio/i.test(id) && suffixes.some((suffix) => id.endsWith(suffix)));
}

// ===========================================================================
// 1. The flag, the route, the harness and the client
// ===========================================================================

describe('acceptance: T-0090 — crm_custom_fields exists, is off, is not production-ready, and gates /admin/custom-fields', () => {
  it('registers crm_custom_fields, not production-ready, and it evaluates OFF by default', async () => {
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

  it('has an /admin/custom-fields route file that calls notFound() on crm_custom_fields, read on the server only', () => {
    expect(existsSync(fromRoot(ROUTE_FILE)), `there is no ${ROUTE_FILE}`).toBe(true);
    const source = withoutComments(readFileSync(fromRoot(ROUTE_FILE), 'utf8'));
    expect(source, `${ROUTE_FILE} does not call notFound()`).toMatch(/\bnotFound\s*\(/);
    expect(source, `${ROUTE_FILE} imports nothing from lib/feature-flags`).toMatch(/from ['"][./]*lib\/feature-flags['"]/);
    const readers = readersOf(FLAG);
    const gated = readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source)) || new RegExp(`['"]${FLAG}['"]`).test(source);
    expect(gated, `${ROUTE_FILE} is not gated on ${FLAG} (readers found: ${readers.join(', ') || 'none'})`).toBe(true);
    expect(source, `${ROUTE_FILE} is a client module`).not.toMatch(/^\s*['"]use client['"]/m);
    const clientEvaluators = webSources().filter(({ source: code }) => /^\s*['"]use client['"]/m.test(code) && code.includes(FLAG));
    expect(clientEvaluators.map(({ file }) => file), `a client module names ${FLAG} — flags are read on the server only`).toEqual([]);
  });

  it('links the studio from somewhere in the admin console (the menu entry, R4)', () => {
    // The browser holds both halves: unlinked on the default server, linked
    // and current on the records process. This only proves a link exists to
    // be gated.
    const linking = webSources().filter(
      ({ file, source }) => file.startsWith('apps/web/components/admin/') && /['"`]\/admin\/custom-fields['"`]/.test(withoutComments(source)),
    );
    expect(linking.map(({ file }) => file), 'nothing in components/admin links /admin/custom-fields').not.toEqual([]);
  });

  it('serves the journeys from the records process with crm_custom_fields on, publishes webStudioUrl, and leaves the default server flagless (R3)', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    const processes = [...runner.matchAll(/KASUWA_FEATURE_FLAGS_ON:\s*['"`]([^'"`]*)['"`]/g)].map((match) => (match[1] ?? '').split(/[,\s]+/));
    expect(
      processes.some((flags) => flags.includes(FLAG) && RECORDS_PROCESS_FLAGS.every((flag) => flags.includes(flag))),
      `no web process in run-e2e.mjs carries ${FLAG} beside ${RECORDS_PROCESS_FLAGS.join(', ')}`,
    ).toBe(true);
    expect(runner, 'run-e2e.mjs does not publish webStudioUrl in the stack file').toContain('webStudioUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*''/);
  });

  it('calls the custom-field operations same-origin, Zod-parsed, with no scope argument, parsing the limits and asking for retired fields by includeRetired', () => {
    const clients = studioClients();
    expect(clients.map(({ file }) => file), `no apps/web/lib module calls ${STUDIO_PATH}`).not.toEqual([]);
    const all = clients.map(({ source }) => withoutComments(source)).join('\n');
    expect(all, 'the client never parses the list’s limits (fieldsPerObject)').toContain('fieldsPerObject');
    expect(all, 'the client never asks for retired fields by includeRetired').toContain('includeRetired');
    expect(all, 'the client never retires (…/retire)').toMatch(/['"`/]retire['"`]|\/retire\b/);
    for (const { file, source } of clients) {
      const code = withoutComments(source);
      expect(code, `${file} names an absolute API origin`).not.toMatch(/https?:\/\/[^'"`]*\/api\/v1/);
      expect(code, `${file} does not parse with Zod`).toMatch(/from ['"]zod['"]/);
      expect(code, `${file} builds a scope argument`).not.toMatch(
        /programmeIds?|ownerUserIds|(set|append)\(\s*['"`](programme|owner|scope|tenant)|['"`]x-[\w-]*(programme|tenant|scope)/i,
      );
    }
    for (const { file: name, source } of webSources()) {
      expect(withoutComments(source), `${name} imports test support`).not.toMatch(
        /from ['"][^'"]*(tests\/e2e|custom-fields-mock|admin-mock|@kasuwa\/testing)[^'"]*['"]/,
      );
    }
  });
});

// ===========================================================================
// 2. i18n — the lint rule, every catalogue, D-P1
// ===========================================================================

describe('acceptance: T-0090 — every string through i18n, in every catalogue, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the /admin/custom-fields route file', () => {
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(
      /files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/,
    );
    // A rule only ever seen passing proves nothing: plant a literal at the route's own path.
    expect(existsSync(fromRoot(ROUTE_FILE)), `there is no ${ROUTE_FILE}`).toBe(true);
    const planted = eslint(
      ['--stdin', '--stdin-filename', ROUTE_FILE, '--format', 'json'],
      'export default function Planted() {\n  return <p>Retire field</p>;\n}\n',
    );
    expect(planted.output, `a literal JSX string at ${ROUTE_FILE} is not rejected:\n${planted.output.slice(-2000)}`).toContain('i18next/no-literal-string');
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const slice = screenSlice();
    const run = eslint(['--max-warnings', '0', ...slice.map(({ file }) => file)]);
    expect(run.status, `eslint fails on the studio slice:\n${run.output.slice(-4000)}`).toBe(0);
    // jsx-text-only cannot see attributes; an English aria-label is still English.
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('puts every message the slice names, and every label the journeys look for, in every design-menu catalogue', async () => {
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
    expect([...named].filter((id) => /custom|studio/i.test(id)).length, 'the studio slice names almost no studio message id').toBeGreaterThan(15);

    const required: string[] = [];
    const find = (what: string, key: string | undefined) => {
      expect(key, `en.json has no label for ${what}`).toBeDefined();
      if (key !== undefined) required.push(key);
    };
    for (const type of TYPES) find(`the ${type} type (an id about the studio ending ".type.${type}")`, studioKey(en, [`.type.${type}`]));
    for (const object of OBJECTS) find(`the ${object} object (an id about the studio ending ".object.${object}")`, studioKey(en, [`.object.${object}`]));
    find('the retired mark (".retired")', studioKey(en, ['.retired']));
    find('the create-default note (".classification_default")', studioKey(en, ['.classification_default', '.classificationDefault']));
    find('the raise warning (".classification_raised")', studioKey(en, ['.classification_raised', '.classificationRaised']));
    const details = customFieldDetailCodes();
    expect(details, 'the custom-field responses declare no detail codes').toEqual(expect.arrayContaining(['invalid_api_name', 'duplicate', 'field_limit_reached', 'field_retired']));
    for (const code of details) find(`the ${code} detail (an id about the studio ending ".${code}")`, studioKey(en, [`.${code}`]));
    for (const level of ['pii', 'sensitive']) {
      find(`the ${level} classification (an id ending ".class.${level}" or ".classification.${level}")`, Object.keys(en).find((id) => id.endsWith(`.class.${level}`) || id.endsWith(`.classification.${level}`)));
    }

    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const key of [...named, ...required]) {
        if (typeof messages[key] !== 'string' || messages[key].trim() === '') {
          missing.push(`${locale}: ${key}`);
        }
      }
    }
    expect(missing, 'message ids the studio uses that a catalogue lacks').toEqual([]);
  });

  it('localises every error code the four custom-field operations can answer', () => {
    const en = catalogue('en');
    const codes = new Set(OPERATIONS.flatMap(([path, method]) => errorCodes(path, method).codes));
    expect([...codes], 'the custom-field operations declare no error codes').toEqual(
      expect.arrayContaining(['validation_failed', 'not_permitted', 'duplicate_code', 'limit_reached']),
    );
    const missing = [...codes].filter((code) => en[`admin.error.${code}`] === undefined);
    expect(missing, 'en.json lacks admin.error.<code> for these errors').toEqual([]);
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
// 3. Tokens only
// ===========================================================================

describe('acceptance: T-0090 — no colour or spacing literal in the slice', () => {
  it('the colour and spacing detectors catch what the lint rule misses', () => {
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
    expect(colourLiterals('className="bg-surface text-text-2 border-border-strong bg-primary-soft text-danger-text"')).toEqual([]);
    for (const planted of [
      'className="p-[13px]"',
      'className="w-[220px] flex"',
      'className="gap-[0.3rem]"',
      'className="lg:max-w-[48rem]"',
      'className="-mt-[2px]"',
      'style={{ padding: 12 }}',
      "style={{ marginTop: '4px' }}",
      "style={{ width: '460px' }}",
    ]) {
      expect(spacingLiterals(planted), `the spacing detector missed ${planted}`).not.toEqual([]);
    }
    expect(spacingLiterals('className="p-3 gap-2 w-72 min-h-touch max-w-[var(--k-sheet)] ps-10 lg:w-1/2"')).toEqual([]);
    expect(spacingLiterals("window.scrollTo({ top: 0 }); const box = { width: 2 }; style={{ inlineSize: 'var(--k-sheet)' }}")).toEqual([]);
  });

  it('the slice reaches the screen and the form through its imports, and stops at the auth shell', () => {
    const slice = screenSlice();
    const files = slice.map(({ file }) => file);
    expect(files).toContain(ROUTE_FILE);
    expect(files.filter((file) => OTHER_SHELLS.some((shell) => file.startsWith(shell)))).toEqual([]);
    expect(files.length, 'the slice is the route alone: nothing it imports was followed').toBeGreaterThan(3);
  });

  it('writes no colour literal anywhere in the slice', () => {
    const found = screenSlice().flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the studio slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('writes no spacing or size literal anywhere in the slice', () => {
    const found = screenSlice().flatMap(({ file, source }) => spacingLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'spacing literals in the studio slice — use the spacing scale from @kasuwa/ui').toEqual([]);
  });
});

// ===========================================================================
// 4. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0090 — the journeys and the mock are the ones this suite was written with', () => {
  it('pins p18-studio.spec.ts and custom-fields-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(
        normalisedHash(file),
        `${file} changed. It is part of the T-0090 acceptance contract: ask the lead to re-pin it ` +
          '(only STUDIO_BUDGET_BYTES may move without that).',
      ).toBe(pinned);
    }
    const mock = readFileSync(fromRoot(MOCK), 'utf8');
    expect(mock, 'the mock no longer reads the admin contract').toContain(CONTRACT);
    expect(mock, 'the mock no longer checks its own answers against the contract').toMatch(/answerProblems\(operation, status, body\)/);
    expect(mock, 'the mock no longer seeds contact from the contract’s own list example').toContain('clone(LIST_EXAMPLE.items)');
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    expect(BUDGET_LITERAL.test(spec), 'STUDIO_BUDGET_BYTES is not where it was').toBe(true);
    expect(spec, 'the spec no longer refuses a waitForTimeout-style sleep').not.toMatch(/waitForTimeout/);
  });
});

// ===========================================================================
// 5. The tag is this screen's alone (D-L84)
// ===========================================================================

describe('acceptance: T-0090 — @p18-studio selects these journeys and nothing else', () => {
  it('no other spec carries a tag @p18-studio matches, ours matches no other parent tag, and the spec carries only ours', () => {
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
// 6. The browser — one run of @p18-studio
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0090 e2e run did not start', outcomes: undefined, startedAt: 0 };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

function outcomes(): E2eOutcome[] {
  expect(e2eRun.outcomes, `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-6000)}`).toBeDefined();
  return e2eRun.outcomes ?? [];
}

describe('acceptance: T-0090 — the customisation studio in a browser', () => {
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

  it('runs every @p18-studio journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(journeys.length, 'the run reported fewer @p18-studio tests than there are behaviours').toBeGreaterThanOrEqual(REQUIRED.length);
    // The one fixme (@p18-studio-writers, R18) is expected to be skipped, and only it.
    const failing = journeys
      .filter((outcome) => !passed(outcome) && !(outcome.tags.includes('@p18-studio-writers') && outcome.status === 'skipped'))
      .map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p18-studio tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter((outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag));
      expect(proving.length, `no PASSING @p18-studio test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('pins /admin/custom-fields at or under 270,000 bytes and within 5% of what this run measured (R24)', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'STUDIO_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /admin/custom-fields budget is above its ceiling').toBeLessThanOrEqual(STUDIO_BUDGET_CEILING);
    expect(budget).toBeLessThan(PRD_CEILING_BYTES);

    const record = fromRoot(BUDGET_RECORD);
    expect(existsSync(record), 'the budget test wrote no measurement').toBe(true);
    expect(statSync(record).mtimeMs, 'the measurement is older than this run').toBeGreaterThanOrEqual(e2eRun.startedAt);
    const measured = (JSON.parse(readFileSync(record, 'utf8')) as { transferredBytes: number }).transferredBytes;
    expect(measured, 'the measurement is empty').toBeGreaterThan(0);
    expect(budget, `the budget is under the ${measured} bytes measured`).toBeGreaterThanOrEqual(measured);
    expect(budget, `the budget is more than 5% over the ${measured} bytes measured — the lead pins STUDIO_BUDGET_BYTES`).toBeLessThanOrEqual(
      Math.round(measured * BUDGET_HEADROOM),
    );
  });
});
