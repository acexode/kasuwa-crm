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
 * ACCEPTANCE — T-0097, the P28 duplicates and merge screen (Agent 11,
 * Frontend & Design System), against T-0093's contract (tag `duplicates`) as
 * T-0095 serves it, on mocks. Also the web audit log's `merged` and
 * `restored` actions (D-L162: "before crm_duplicates is shown"). Decisions:
 * D-P12, D-P14, D-P27, D-P28, D-L84, D-L146, D-L148, D-L151, D-L162, D-L163,
 * D-L165, D-L173. Written by the lead's QA agent before the screen exists
 * (D-L23).
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. `crm_duplicates`: registered, DEFAULT OFF, NOT production-ready, read on
 *      the server through `lib/feature-flags.ts`. `/contacts/duplicates`
 *      (`apps/web/app/contacts/duplicates/page.tsx`) calls `notFound()` and is
 *      gated on it by name, so with every flag at its default it is a real
 *      404. No client module names it. `crmLiveNav()` lists `duplicates`
 *      exactly when it is on, and every module that links
 *      `/contacts/duplicates` decides by `live.includes('duplicates')`.
 *   2. The harness: the builder adds `crm_duplicates` to the RECORDS web
 *      process and publishes `webDuplicatesUrl`, in the change that registers
 *      the flag (naming an unregistered flag stops that process booting).
 *      Every older records-ui suite then runs with it on: their journeys and
 *      pinned byte budgets must still pass.
 *   3. A client in `apps/web/lib/` calls the five operations same-origin,
 *      Zod-parsed, never from the HTTP cache, with no scope argument.
 *   4. The screen against the contract mock, by e2e tag (section 6; hooks and
 *      rules in the header of `tests/e2e/p28-duplicates.spec.ts`).
 *   5. i18n: the literal-string rule fires on the route; every message id the
 *      slice names is in every design-menu catalogue; the fixed sentences
 *      below; `records.error.<code>` for every error the five operations
 *      answer (`already_merged` and `undo_expired` included, D-L148).
 *   6. The audit log: the web `AuditAction` enum IS the admin contract's
 *      (`merged`, `restored` included), each with a label in every catalogue
 *      and in the audit screen's message ids.
 *   7. No colour literal, no device storage and no HTML injection in the slice.
 *
 * RULINGS (the suite is written to these; the lead accepts or amends them)
 *
 *   I1. Flag and route. `crm_duplicates` (named by the task file and D-L146;
 *       NOT yet in FLAGS on main, so the builder registers it, as T-0094 did
 *       `crm_import`). A PRESENTATION switch: T-0095 shipped the five
 *       operations ungated, and this flag does not gate them.
 *       `/contacts/duplicates` on the CRM shell; C (the sets), C1 (the merge)
 *       and the merges history on that one route. The Contacts list links it
 *       where the flag is live. Rides on the records process
 *       (`webDuplicatesUrl`).
 *   I2. Sets. listDuplicates for the programme chosen from listMyProgrammes,
 *       in the PATH (D-L148), `cursor` and `limit` only; the landing scans the
       first programme served, and the select changes it. The next page sends
 *       `nextCursor` unchanged and appends in served order. "Matches on
 *       phone" or "on email" in words; no value, no score, no confidence
 *       (D-P12). A null name is a withheld label, never "null" and never
 *       marked as record data. `updatedAt` in `<time>`. An empty programme has
 *       an empty state. One scan per landing, programme change, next page,
 *       explicit retry, or return after a merge or an undo: no polling, no
 *       refetch on focus (each page is a whole-programme scan, D-L163).
 *   I3. Throttle (D-L163, D-L165). A 429 is a translated wait message, not a
 *       connection error and not "no duplicates"; sets already drawn stay.
 *       Nothing is asked again until `Retry-After` seconds have passed; then
 *       one retry, automatic or by a control that is disabled until then. The
 *       mock also refuses more than 20 scans a minute.
 *   I4. Pairwise (D-L146). A set of two opens C1 directly; in a larger set
 *       exactly two are picked before Review is enabled.
 *   I5. Preview. The main record (survivor) is a radio choice; changing it
 *       re-reads getContactMergePreview the other way round and re-sets the
 *       picks from the new `defaults`. CHOOSABLE = the keys of `defaults`
 *       (T-0095 lists every field the caller may edit, equal values
 *       included): each a named radio group in a `<table>` row with a row
 *       header, pre-set to the default. A field either side withholds is drawn
 *       withheld, with no value and no choice. A field readable on both sides
 *       but absent from `defaults` is read-only: locked, no choice.
 *   I6. Compliance (D-P28, D-L146). `dnd`, `whatsappOptIn`, `consentState`
 *       show `compliance` (the outcome), locked, translated, whichever record
 *       is the main one, with "the most restrictive choice is kept"; never
 *       "most recent". One withheld from the caller is drawn withheld. Never
 *       sent.
 *   I7. Merge. A confirm dialog first (named, focus inside; cancel and Escape
 *       send nothing and return focus). createContactMerge carries the last
 *       preview's ids and versions, and `choices` naming only keys of its
 *       `defaults`, each `survivor` or `merged`. One request per
 *       confirmation, however often it is clicked.
 *   I8. Result. The survivor's link `/contacts/<survivorId>`, Undo, and the
 *       deadline `undoUntil` in `<time>`. No link anywhere to a merged-away
 *       contact (it is the one 404, D-P27). Back on the sets, the merged-away
 *       contact is not offered; the merge is in the history.
 *   I9. Merge refusals, translated in `duplicates-error`, never a raw code:
 *       409 `already_merged` (the sets are read again and the pair is gone);
 *       409 `stale_write` (the preview is read again; the next merge carries
 *       the new versions); 403 `not_permitted` (an agent, D-P14: the controls
 *       stay, D-L84); 403 `field_not_editable` at `choices.<field>` (that field
 *       is locked and never sent again).
 *   I10. Undo (from the result or the history; no body). 200 draws the undone
 *       state; `survivorReverted: false` says the main record kept its edits.
 *       410 `undo_expired`: translated, and the merge turns expired (the
 *       server's clock wins over the browser's). 404 (the merger lost
 *       `contact.write`, D-L163): the GENERIC not-found words
 *       (`records.error.not_found`), nothing about permission, and undo is
 *       offered no more. 403 (another user's merge): `not_permitted`. 409
 *       `already_merged`: translated. A refused undo is never sent again.
 *   I11. History (D-P27). listContactMerges as served, newest first; `cursor`
 *       and `limit` only; the next page by `nextCursor`. Each row: both names
 *       (or the withheld label), `mergedAt` in `<time>`, and a state: OPEN
 *       (undone null, `undoUntil` ahead) offers Undo, also for another user's
 *       merge (D-L84: the 403 is the gate); UNDONE says so (and the kept-edits
 *       note when `survivorReverted` is false); EXPIRED says "undo expired".
 *       A merged-away party is never linked. A non-writer's empty list is the
 *       empty history, not an error.
 *   I12. Contacts. A merged-away contact leaves the Contacts list and its
 *       record is the generic not-found (both the API's doing; the screen
 *       keeps no copy). The contract exposes NO "merged into" pointer, so no
 *       "merged into" link is drawn, and the not-found page names nothing.
 *   I13. Audit log (D-L162). The web `AuditAction` enum equals
 *       `admin.openapi.yaml`'s exactly; `admin.audit.action.merged` and
 *       `.restored` are in every catalogue and in `ADMIN_AUDIT_MESSAGE_IDS`;
 *       `/admin/audit` draws both events labelled and offers both as filters.
 *       NOT behind `crm_duplicates`: the API merges whatever any web flag says.
 *   I14. i18n under `duplicates.*`, with the sentences in SENTENCES below, and
 *       `records.error.<code>` for every error code the five operations
 *       publish.
 *   I15. Privacy. No name, number or address in the console, a URL, history
 *       state or the title; nothing kept on the device (D-P21); no id printed.
 *       Names and companies are drawn as text (no HTML injection).
 *   I16. 360 px: the comparison stacks; no sideways scroll; axe-clean.
 *   I17. Budget. DUPLICATES_BUDGET_BYTES is a PROVISIONAL 250,000-byte
 *       placeholder under a 255,000 ceiling; the lead re-pins it within 5% of
 *       the builder's first green measurement (D-L118), and until then the
 *       budget check below fails by design, as T-0109's and T-0096's did.
 *
 * WHERE THE TASK FILE OR THE DESIGN DISAGREES WITH WHAT IS BUILT (ruled for
 * what is built)
 *
 *   C1. The "merged into" link on a contact record: the contract has no such
 *       field, and getContact on a merged-away id is the one NotFound body.
 *       Not drawn (I12).
 *   C2. The design's "Merge 3 contacts": pairwise only (D-L146, the contract).
 *   C3. The design's "Matching rules", "Confidence", "Why they match" with
 *       values and "Found": exact phone or email only, no value or score
 *       served (D-P12); DuplicateContact has `updatedAt` only.
 *   C4. "SMS consent keeps the most recent choice": most restrictive (D-P28;
 *       the task file already overrules it).
 *   C5. "Not duplicates": no operation exists to dismiss a set. Not built.
 *   C6. "Moves to the merged record" counts: the preview serves none.
 *   C7. "the others are archived and can be restored for 30 days": restore is
 *       undoContactMerge, allowed only to the merging user or a tenant admin
 *       (D-L151); the control is still shown to others (D-L84).
 *   C8. The task file says the `agent` set "gets 403": true for
 *       createContactMerge; listContactMerges answers an agent an EMPTY 200
 *       ("others see no merges"), and listDuplicates and the preview are open
 *       to any reader.
 *   C9. CONTRACT, FOR THE LEAD: `Contact.displayName` is "never withheld" but
 *       `DuplicateContact.displayName` and `ContactMergeParty.displayName` are
 *       null "when field security withholds it". The screen handles null where
 *       the schema allows it; the mock never serves a withheld name in a
 *       preview. Also, the getContactMergePreview example's `defaults` omits
 *       fields with equal values, which T-0095 does not (it lists every
 *       editable field); the mock follows T-0095.
 *   C10. FOR THE LEAD: the audit-screen requirement is D-L162's, not in the
 *       T-0097 task file; it is pinned here as asked. And `crm_duplicates`
 *       was to be registered by D-L146's "Step 0" registry PR, which did not
 *       register it: the builder does (I1).
 *
 * BUILDER'S CHOICES: the layout; whether the merge is a panel or a step on
 * the route; whether a 429 retries by itself; which record is the default
 * main one; whether the result refreshes the history by re-reading it or
 * locally; the copy; the slice's files.
 *
 * NOT HELD HERE, AND WHY
 *   - The live journey against T-0095's real API: a follow-up once this
 *     screen merges, as for T-0096.
 *   - Custom fields in a merge (`custom.<key>` choices): the screen must not
 *     break on them, but no journey serves any (no custom definitions are
 *     served to this mock).
 *   - The owner pick (`choices.ownerUserId`, 400 `unknown_reference`): there is
 *     no user directory to name owners (D-L64), so whether the owner row is
 *     drawn is the builder's choice.
 *
 * THE BROWSER HALF. `tests/e2e/p28-duplicates.spec.ts` (journeys) and
 * `tests/e2e/support/duplicates-mock.ts` (the contract mock, which checks
 * every request and every answer against the YAML) were written with this
 * suite and are PINNED by hash below, because `tests/e2e` is not
 * path-protected (D-L64). DUPLICATES_BUDGET_BYTES is the one line that may
 * change without a re-pin.
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p28-duplicates --reporter=list,<ours>
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

const FLAG = 'crm_duplicates';
/** The flags of the records process that `crm_duplicates` rides on. */
const RECORDS_PROCESS_FLAGS = ['crm_records', 'crm_accounts', 'crm_record_view', 'crm_leads', 'crm_activities', 'crm_pipeline', 'crm_search', 'crm_custom_fields', 'crm_import'];

const ROUTE = 'apps/web/app/contacts/duplicates/page.tsx';
const ROUTE_DIRECTORY = 'apps/web/app/contacts/duplicates/';
const SHELL_DIRECTORY = 'apps/web/components/crm/';
const CONTACTS_DIRECTORY = 'apps/web/components/contacts/';
const LINK = '/contacts/duplicates';

const E2E_TAG = '@p28-duplicates';

/** `next build` (SWC wasm on the dev host, D-L62), a container, the servers and the journeys. */
const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p28-duplicates.spec.ts';
const MOCK = 'tests/e2e/support/duplicates-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/p28-duplicates-budget.json';
const CONTRACT = 'docs/api/records.openapi.yaml';
const ADMIN_CONTRACT = 'docs/api/admin.openapi.yaml';

/**
 * The pinned browser half (CRLF folded to LF; the budget literal normalised).
 * A change to either file is a change to the acceptance contract: the lead
 * re-pins it, the builder does not.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  [SPEC]: 'b3526f34441519817b78a26957518f757e7a057bc19606135df844b7865c3a3d',
  [MOCK]: '30a42bcc965c9f76eb22504e2708a5f1166194c8c5c4204fdf6823316180e74f',
};

/** Never above this (I17). */
const DUPLICATES_BUDGET_CEILING = 285_000; // D-L203: T-0145 measured, after removing the weight it could (no visual change)
const BUDGET_HEADROOM = 1.05;
const PRD_CEILING_BYTES = 300 * 1024;

const DUPLICATES_OPERATIONS: readonly (readonly [path: string, method: string])[] = [
  ['/api/v1/programmes/{programmeId}/duplicates', 'get'],
  ['/api/v1/contacts/{contactId}/merge-preview', 'get'],
  ['/api/v1/contact-merges', 'post'],
  ['/api/v1/contact-merges', 'get'],
  ['/api/v1/contact-merges/{mergeId}/undo', 'post'],
];

/** What the client must name to reach the five operations. */
const CLIENT_PATHS = ['/duplicates', '/merge-preview', '/api/v1/contact-merges'];

/** Fixed sentences, by what each id (under `duplicates.`) must contain and may end with. */
const SENTENCES: Readonly<Record<string, { readonly parts: readonly string[]; readonly suffixes: readonly string[] }>> = {
  'matches on phone (I2)': { parts: ['match'], suffixes: ['.phone'] },
  'matches on email (I2)': { parts: ['match'], suffixes: ['.email'] },
  'the withheld label (I2, I5)': { parts: ['withheld'], suffixes: [''] },
  '"undo expired" (I11)': { parts: ['expired'], suffixes: [''] },
  'the undone state (I11)': { parts: ['undone'], suffixes: [''] },
};

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the mock's validators
  // fire, so every afterEach "no violations" means something.
  ['@p28-duplicates-mock', 'the contract mock refuses what the contract and the screen’s rules refuse, and checks its own answers'],
  // Passes before the work starts too (there is no route): a negative
  // invariant, given meaning by @p28-duplicates-flag-on.
  ['@p28-duplicates-flag-off', '/contacts/duplicates is a 404 with crm_duplicates at its default, and the browser cannot flip it'],
  ['@p28-duplicates-flag-on', '/contacts/duplicates renders P28 in the CRM shell: the programme, the sets and the history'],
  ['@p28-duplicates-entry', 'the Contacts list links the screen; no link on it is a 404 or a merged-away contact'],
  ['@p28-duplicates-programme', 'the programme is a session programme by name, in the path; an empty one says so'],
  ['@p28-duplicates-sets', 'sets as served: matched on phone or email in words, names as text, withheld labelled, <time>, no value or score'],
  ['@p28-duplicates-paging', 'the next page by the served cursor, appended, the control gone at the end'],
  ['@p28-duplicates-throttle', 'a 429 is a translated wait; nothing is asked before Retry-After; the sets stay'],
  ['@p28-duplicates-pair', 'in a set of three, exactly two are picked before Review'],
  ['@p28-duplicates-preview', 'the main record re-reads the preview; picks start at the defaults; a table with row headers'],
  ['@p28-duplicates-withheld', 'withheld fields shown withheld and never chosen; read-only locked'],
  ['@p28-duplicates-compliance', 'compliance locked at the most restrictive outcome, with the note, never sent (D-P28)'],
  ['@p28-duplicates-confirm', 'a confirm dialog; cancel and Escape send nothing; one merge per confirmation'],
  ['@p28-duplicates-merge', 'the preview’s versions and the picks; the result links the survivor, offers undo until undoUntil'],
  ['@p28-duplicates-already-merged', '409 already_merged translated; the sets read again without the pair'],
  ['@p28-duplicates-stale', '409 stale_write translated; the preview read again; the new version sent'],
  ['@p28-duplicates-forbidden', 'an agent’s 403 translated; controls stay (D-L84); the empty history is no error'],
  ['@p28-duplicates-field-refused', '403 field_not_editable locks the field, never sent again'],
  ['@p28-duplicates-undo', 'undo from the result and the history; survivorReverted false explained'],
  ['@p28-duplicates-undo-expired', '"undo expired" with no undo; a 410 turns a merge expired'],
  ['@p28-duplicates-undo-not-found', 'a 404 undo reads as not found, never as permission, and is offered no more'],
  ['@p28-duplicates-undo-refused', '403 and 409 on undo translated'],
  ['@p28-duplicates-history', 'the history as served: names, <time>, states, undo only where open, the next page'],
  ['@p28-duplicates-contacts', 'the merged-away contact gone from Contacts; its record the generic not-found, no "merged into"'],
  ['@p28-duplicates-markup', 'markup in a name or a company drawn as text'],
  ['@p28-duplicates-privacy', 'no name, number or address in the console, URLs, history or title; nothing on the device'],
  ['@p28-duplicates-axe', 'every frame axe-clean; named radio groups'],
  ['@p28-duplicates-mobile', '360 px without sideways scroll, axe-clean'],
  ['@p28-duplicates-pseudo', 'en-XA renders every string as pseudo text, record data excepted'],
  ['@p28-duplicates-audit', 'the audit log draws merged and restored, labelled, and filters by them (D-L162)'],
  ['@p28-duplicates-budget', '/contacts/duplicates inside its byte budget on the production build'],
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
    slice.filter(({ source }) => /['"`]P28['"`]/.test(withoutComments(source)) && /merge/i.test(source)).map(({ file }) => file),
    'the /contacts/duplicates route imports no P28 merge screen (data-screen="P28")',
  ).not.toEqual([]);
  return slice;
}

/** apps/web/lib modules that call the duplicates operations. */
function duplicatesClients(): SourceFile[] {
  return webSources().filter(({ file, source }) => file.startsWith('apps/web/lib/') && CLIENT_PATHS.some((path) => withoutComments(source).includes(path)));
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8')) as Record<string, string>;
}

const BUDGET_LITERAL = /const DUPLICATES_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8').replace(/\r\n/g, '\n').replace(BUDGET_LITERAL, 'const DUPLICATES_BUDGET_BYTES = <budget>;');
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

type Json = Record<string, unknown>;

interface Contract {
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string }> }>>;
  components: { responses: Record<string, Json>; schemas: Record<string, Json> };
}

function contract(source = CONTRACT): Contract {
  return parse(readFileSync(fromRoot(source), 'utf8')) as Contract;
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

/** The admin contract's audit actions. */
function auditActions(): string[] {
  const node = contract(ADMIN_CONTRACT).components.schemas.AuditAction?.enum;
  return Array.isArray(node) ? node.map(String) : [];
}

/** The members of `export const AuditAction = z.enum([...])` in the web admin client. */
function webAuditActions(source: string): string[] | undefined {
  const match = /export\s+const\s+AuditAction\s*=\s*z\.enum\(\s*\[([\s\S]*?)\]\s*\)/.exec(withoutComments(source));
  if (match === null) return undefined;
  return [...(match[1] ?? '').matchAll(/['"]([a-z_]+)['"]/g)].map((entry) => entry[1] ?? '');
}

/** en.json ids under `duplicates.` containing every one of `parts` (case-insensitive) and ending with one of `suffixes`. */
function keysFor(en: Record<string, string>, parts: readonly string[], suffixes: readonly string[]): string[] {
  return Object.keys(en).filter((id) => id.startsWith('duplicates.') && parts.every((part) => id.toLowerCase().includes(part.toLowerCase())) && suffixes.some((suffix) => id.endsWith(suffix)));
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

/** Markup built from strings (I15): a name or a company must be drawn as text. */
function htmlInjection(source: string): string[] {
  return withoutComments(source).match(/\bdangerouslySetInnerHTML\b|\.(?:innerHTML|outerHTML)\s*=|\binsertAdjacentHTML\b|\bdocument\.write\b|\bcreateContextualFragment\b/g) ?? [];
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

describe('acceptance: T-0097 — crm_duplicates exists, is off, is not production-ready, and gates /contacts/duplicates and its link', () => {
  it('registers crm_duplicates, not production-ready, and it evaluates OFF by default (I1)', async () => {
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

  it('has /contacts/duplicates calling notFound() on crm_duplicates, read on the server only (I1)', () => {
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

  it('lists duplicates in crmLiveNav() only through crm_duplicates, and links /contacts/duplicates only where live.includes("duplicates") (I1)', () => {
    const live = flagFunctionBody('crmLiveNav');
    expect(live, 'crmLiveNav() is gone from lib/feature-flags.ts').not.toBe('');
    expect(live, 'crmLiveNav() never lists duplicates').toMatch(/['"]duplicates['"]/);
    const readers = readersOf(FLAG).filter((name) => name !== 'crmLiveNav');
    expect(
      readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(live)) || new RegExp(`['"]${FLAG}['"]`).test(live),
      'crmLiveNav() does not read crm_duplicates: the link would show with the flag off',
    ).toBe(true);
    const linking = webSources().filter(({ file, source }) => !file.startsWith(ROUTE_DIRECTORY) && new RegExp(`['"\`]${LINK}['"\`]`).test(withoutComments(source)));
    expect(linking.map(({ file }) => file), `nothing links ${LINK}: the screen has no entry`).not.toEqual([]);
    for (const { file, source } of linking) {
      expect(withoutComments(source), `${file} links ${LINK} without asking live.includes("duplicates")`).toMatch(/\.includes\(\s*['"]duplicates['"]\s*\)/);
    }
    expect(linking.some(({ file }) => file.startsWith(CONTACTS_DIRECTORY) || file.startsWith(SHELL_DIRECTORY)), 'neither the Contacts list nor the CRM shell links the screen').toBe(true);
  });

  it('serves the journeys from the records process with crm_duplicates on, publishes webDuplicatesUrl, and leaves the default server flagless (I1)', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    const processes = [...runner.matchAll(/KASUWA_FEATURE_FLAGS_ON:\s*['"`]([^'"`]*)['"`]/g)].map((match) => (match[1] ?? '').split(/[,\s]+/));
    expect(
      processes.some((flags) => flags.includes(FLAG) && RECORDS_PROCESS_FLAGS.every((flag) => flags.includes(flag))),
      `no web process in run-e2e.mjs carries ${FLAG} beside ${RECORDS_PROCESS_FLAGS.join(', ')}`,
    ).toBe(true);
    expect(runner, 'run-e2e.mjs does not publish webDuplicatesUrl in the stack file').toContain('webDuplicatesUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*''/);
  });

  it('calls the five operations same-origin, Zod-parsed, never from the HTTP cache, with no scope argument (I2)', () => {
    const clients = duplicatesClients();
    expect(clients.map(({ file }) => file), 'no apps/web/lib module calls the duplicates operations').not.toEqual([]);
    const all = clients.map(({ source }) => withoutComments(source)).join('\n');
    for (const path of CLIENT_PATHS) expect(all, `no apps/web/lib module names ${path}`).toContain(path);
    for (const { file, source } of clients) {
      const code = withoutComments(source);
      expect(code, `${file} names an absolute API origin`).not.toMatch(/https?:\/\/[^'"`]*\/api\/v1/);
      expect(code, `${file} does not parse with Zod`).toMatch(/from ['"]zod['"]/);
      expect(code, `${file} builds a scope argument`).not.toMatch(/programmeIds|ownerUserIds|(set|append)\(\s*['"`](programme|owner|scope)|['"`]x-[\w-]*(programme|tenant|scope)|[?&]programmeId=/i);
      // Sets and merges name people at a URL that is the same for every user: never the HTTP cache (records-cache.test.ts).
      expect(/\brequestRecords\b/.test(code) || /cache:\s*['"]no-store['"]/.test(code), `${file} neither goes through requestRecords nor sends cache: 'no-store'`).toBe(true);
    }
    for (const { file, source } of webSources()) {
      expect(withoutComments(source), `${file} imports test support`).not.toMatch(/from ['"][^'"]*(tests\/e2e|duplicates-mock|@kasuwa\/testing)[^'"]*['"]/);
    }
  });

  it('keeps the duplicates screen out of every other screen’s first load: the CRM shell and the Contacts list import none of it', () => {
    // A static check. The real one is every other records-ui suite's pinned
    // byte budget, which still runs with crm_duplicates on (I1).
    const slice = screenSlice().map(({ file }) => file);
    const own = slice.filter((file) => file.startsWith(ROUTE_DIRECTORY) || (/['"`]P28['"`]/.test(readFileSync(fromRoot(file), 'utf8')) && /merge/i.test(readFileSync(fromRoot(file), 'utf8'))));
    const roots = [...trackedFiles(SHELL_DIRECTORY), ...trackedFiles(CONTACTS_DIRECTORY), 'apps/web/app/contacts/page.tsx'].filter((file) => /\.(tsx?|mjs)$/.test(file) && !/\.test\.tsx?$/.test(file));
    const loaded = reachableFrom(roots, true, ['apps/web/components/auth/', 'apps/web/components/admin/']);
    expect(own.filter((file) => loaded.has(file)), 'the CRM shell or the Contacts list imports the duplicates screen').toEqual([]);
  });
});

// ===========================================================================
// 2. i18n — the lint rule, every catalogue, the error codes, D-P1
// ===========================================================================

describe('acceptance: T-0097 — every string through i18n, in every catalogue, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the /contacts/duplicates route file', () => {
    // Passes before the work starts: a guard that the rule stays live on the route's path.
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(/files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/);
    // A rule only ever seen passing proves nothing: plant a literal at the route's own path.
    const planted = eslint(['--stdin', '--stdin-filename', ROUTE, '--format', 'json'], 'export default function Planted() {\n  return <p>Merge contacts</p>;\n}\n');
    expect(planted.output, `a literal JSX string at ${ROUTE} is not rejected:\n${planted.output.slice(-2000)}`).toContain('i18next/no-literal-string');
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const slice = screenSlice();
    const run = eslint(['--max-warnings', '0', ...slice.map(({ file }) => file)]);
    expect(run.status, `eslint fails on the duplicates slice:\n${run.output.slice(-4000)}`).toBe(0);
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('puts every message the slice names, and every fixed sentence, in every design-menu catalogue (I14)', async () => {
    const i18n: { DESIGN_MENU_LOCALES: readonly string[] } = await import(fromRoot('packages/i18n/src/index.ts'));
    const en = catalogue('en');
    const named = new Set<string>();
    for (const { source } of screenSlice()) {
      for (const match of withoutComments(source).matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)) {
        if (match[1] !== undefined && en[match[1]] !== undefined) named.add(match[1]);
      }
    }
    // Vacuity guard: the CRM shell alone names about a dozen ids; the screen must add its own namespace.
    expect([...named].filter((id) => id.startsWith('duplicates.')).length, 'the duplicates slice names almost no duplicates.* message id').toBeGreaterThan(15);

    const one = (what: string, parts: readonly string[], suffixes: readonly string[]): string => {
      const found = keysFor(en, parts, suffixes);
      expect(found.length, `en.json has no label for ${what} (an id under duplicates. containing ${parts.map((part) => `"${part}"`).join(' and ')}${suffixes.join('') === '' ? '' : ` ending ${suffixes.join(' or ')}`})`).toBeGreaterThan(0);
      return found[0] ?? `<missing ${what}>`;
    };
    const sentences = Object.entries(SENTENCES).map(([what, { parts, suffixes }]) => [what, one(what, parts, suffixes)] as const);
    const kept = [...keysFor(en, ['kept'], ['']), ...keysFor(en, ['revert'], [''])];
    expect(kept.length, 'en.json has no label for "the main record kept its edits" (survivorReverted false; an id under duplicates. containing "kept" or "revert")').toBeGreaterThan(0);

    // The compliance note (I6): some duplicates.*compliance* message says the most restrictive choice is kept, and none promises the most recent.
    const compliance = keysFor(en, ['compliance'], ['']);
    expect(compliance.filter((key) => /restrict|strict/i.test(en[key] ?? '')), 'no duplicates.*compliance* message says the most restrictive choice is kept (D-P28)').not.toEqual([]);
    expect(compliance.filter((key) => /most recent|latest|newest/i.test(en[key] ?? '')), 'a compliance message promises the most recent choice (D-P28 is most restrictive)').toEqual([]);
    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const key of [...named, ...sentences.map(([, key]) => key), ...kept.slice(0, 1), ...compliance]) {
        if (typeof messages[key] !== 'string' || messages[key].trim() === '') missing.push(`${locale}: ${key}`);
      }
    }
    expect(missing, 'message ids the duplicates screen uses that a catalogue lacks').toEqual([]);
    for (const [what, key] of sentences.filter(([label]) => label.startsWith('matches'))) {
      expect(en[key] ?? '', `${what} names a score or a fuzzy match (D-P12)`).not.toMatch(/score|confidence|similar|likely|\d\s?%/i);
    }
  });

  it('localises every error the five operations can answer with, already_merged and undo_expired included (D-L148)', () => {
    const en = catalogue('en');
    const codes = new Set(DUPLICATES_OPERATIONS.flatMap(([path, method]) => errorCodes(path, method)));
    expect([...codes], 'the duplicates operations no longer declare their own codes').toEqual(expect.arrayContaining(['already_merged', 'undo_expired', 'stale_write', 'not_permitted', 'not_found', 'too_many_requests']));
    const admin = parse(readFileSync(fromRoot(ADMIN_CONTRACT), 'utf8')) as { components: { schemas: { Error: { properties: { code: { enum: string[] } } } } } };
    expect(admin.components.schemas.Error.properties.code.enum, 'the shared Error envelope lost a merge code').toEqual(expect.arrayContaining(['already_merged', 'undo_expired']));
    const missing = [...codes].filter((code) => en[`records.error.${code}`] === undefined);
    expect(missing, 'en.json lacks records.error.<code> for these errors').toEqual([]);
    for (const code of codes) {
      expect(en[`records.error.${code}`] ?? '', `records.error.${code} just repeats the code`).not.toContain(code);
    }
    // The 404 words are the generic ones: nothing about permission (I10, CLAUDE.md 6.4).
    expect(en['records.error.not_found'] ?? '', 'records.error.not_found talks about permission').not.toMatch(/permission|not allowed|forbidden/i);
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
// 3. The audit log knows merged and restored (D-L162)
// ===========================================================================

describe('acceptance: T-0097 — the audit log’s actions are the admin contract’s, merged and restored included (I13)', () => {
  it('has the web AuditAction enum equal to admin.openapi.yaml’s AuditAction', () => {
    const contractActions = auditActions();
    // Vacuity guard: the contract must still publish the two T-0095 added (migration 0043, D-L173).
    expect(contractActions, 'the admin contract no longer publishes merged and restored').toEqual(expect.arrayContaining(['merged', 'restored']));
    const web = webAuditActions(readFileSync(fromRoot('apps/web/lib/admin-api.ts'), 'utf8'));
    expect(web, 'apps/web/lib/admin-api.ts no longer declares `export const AuditAction = z.enum([...])`').toBeDefined();
    expect([...(web ?? [])].sort(), 'the web audit log parses a different set of actions from the contract: a page holding a merge fails to parse').toEqual([...contractActions].sort());
  });

  it('labels every audit action in every design-menu catalogue and in the audit screen’s message ids', async () => {
    const i18n: { DESIGN_MENU_LOCALES: readonly string[] } = await import(fromRoot('packages/i18n/src/index.ts'));
    const actions = auditActions();
    expect(actions.length).toBeGreaterThan(10);
    const ids = withoutComments(readFileSync(fromRoot('apps/web/components/admin/message-ids.ts'), 'utf8'));
    const block = /export\s+const\s+ADMIN_AUDIT_MESSAGE_IDS[^=]*=\s*\[([\s\S]*?)\];/.exec(ids)?.[1] ?? '';
    expect(block, 'ADMIN_AUDIT_MESSAGE_IDS is gone from apps/web/components/admin/message-ids.ts').not.toBe('');
    expect(actions.filter((action) => !block.includes(`'admin.audit.action.${action}'`)), 'audit actions the audit screen bundles no label for').toEqual([]);
    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const action of actions) {
        const value = messages[`admin.audit.action.${action}`];
        if (typeof value !== 'string' || value.trim() === '') missing.push(`${locale}: admin.audit.action.${action}`);
      }
    }
    expect(missing, 'audit action labels a catalogue lacks').toEqual([]);
    const en = catalogue('en');
    for (const action of ['merged', 'restored']) expect(en[`admin.audit.action.${action}`] ?? '', `admin.audit.action.${action} just repeats the code`).not.toBe(action);
  });
});

// ===========================================================================
// 4. Colour, the device and markup
// ===========================================================================

describe('acceptance: T-0097 — no colour literal, no device storage, no HTML built from strings', () => {
  it('the detectors catch what they are for', () => {
    // Planted first: a detector only ever seen finding nothing proves nothing.
    // Passes before the work starts, by design.
    for (const planted of ['className="text-[#c00] p-2"', "style={{ color: 'red' }}", 'className="bg-sky-100"', 'className="border-white"']) {
      expect(colourLiterals(planted), `the colour detector missed ${planted}`).not.toEqual([]);
    }
    expect(colourLiterals('className="bg-surface text-text-2 border-border-strong bg-primary-soft"')).toEqual([]);
    for (const planted of ["localStorage.setItem('merge', id)", 'indexedDB.open("sets")', 'await caches.open("x")']) {
      expect(DEVICE_STORAGE.test(planted), `the device-storage detector missed ${planted}`).toBe(true);
    }
    for (const planted of ['<td dangerouslySetInnerHTML={{ __html: name }} />', 'cell.innerHTML = contact.displayName;', "row.insertAdjacentHTML('beforeend', name)"]) {
      expect(htmlInjection(planted), `the markup detector missed ${planted}`).not.toEqual([]);
    }
    expect(htmlInjection('<td>{contact.displayName}</td>')).toEqual([]);
    expect(webAuditActions("export const AuditAction = z.enum([\n  'created',\n  // a note\n  'merged',\n]);"), 'the enum reader missed a member').toEqual(['created', 'merged']);
    // The first-load walk, on planted modules: a static import is seen, a dynamic one only when asked.
    const shell = 'apps/web/components/crm/crm-shell.tsx';
    const screen = 'apps/web/components/duplicates/duplicates-screen.tsx';
    const planted = (code: string) => new Map([[shell, code], [screen, "export const id = 'P28';"]]);
    expect(reachableFrom([shell], false, [], planted("import { DuplicatesScreen } from '../duplicates/duplicates-screen';")).has(screen)).toBe(true);
    expect(reachableFrom([shell], false, [], planted("import type { DuplicatesScreenProps } from '../duplicates/duplicates-screen';")).has(screen)).toBe(false);
    expect(reachableFrom([shell], true, [], planted("const Lazy = dynamic(() => import('../duplicates/duplicates-screen'));")).has(screen)).toBe(true);
  });

  it('writes no colour literal anywhere in the slice', () => {
    const found = screenSlice().flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the duplicates slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('touches no device-storage API and builds no HTML from strings (I15, D-P21)', () => {
    const files = [...screenSlice(), ...duplicatesClients()];
    expect(files.filter(({ source }) => DEVICE_STORAGE.test(withoutComments(source))).map(({ file }) => file), 'the duplicates slice uses a device-storage API').toEqual([]);
    expect(files.flatMap(({ file, source }) => htmlInjection(source).map((hit) => `${file}: ${hit}`)), 'the duplicates slice builds HTML from strings: names are record data, drawn as text').toEqual([]);
  });
});

// ===========================================================================
// 5. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0097 — the journeys and the mock are the ones this suite was written with', () => {
  it('pins p28-duplicates.spec.ts and duplicates-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(normalisedHash(file), `${file} changed. It is part of the T-0097 acceptance contract: ask the lead to re-pin it (only DUPLICATES_BUDGET_BYTES may move without that).`).toBe(pinned);
    }
    const mock = readFileSync(fromRoot(MOCK), 'utf8');
    expect(mock, 'the mock no longer reads the records contract').toContain(CONTRACT);
    expect(mock, 'the mock no longer checks its own answers against the contract').toMatch(/answerProblems\(operation, status, body\)/);
    expect(mock, 'the mock no longer reads the compliance order').toContain("'x-kasuwa-compliance-order'");
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    expect(BUDGET_LITERAL.test(spec), 'DUPLICATES_BUDGET_BYTES is not where it was').toBe(true);
  });
});

// ===========================================================================
// 6. The tag is this screen's alone (D-L84)
// ===========================================================================

describe('acceptance: T-0097 — @p28-duplicates selects these journeys and nothing else', () => {
  it('no other spec carries a tag @p28-duplicates matches, no other parent tag matches ours, and the spec carries only ours', () => {
    // Passes before the work starts: it guards the tag against T-0096's
    // `@p28-import` and any later P28 spec.
    const specs = trackedFiles('tests/e2e').filter((file) => file.endsWith('.spec.ts') && existsSync(fromRoot(file)));
    expect(specs).toContain(SPEC);
    expect(new RegExp('@p28-import').test(E2E_TAG)).toBe(false);
    expect(new RegExp(E2E_TAG).test('@p28-import-mock')).toBe(false);
    expect(new RegExp(parentTag(['@p28', '@p28-list']) ?? '(none)').test(E2E_TAG), 'a bare @p28 parent was not caught').toBe(true);
    const ours = tagsIn(SPEC);
    expect(ours.length).toBeGreaterThan(REQUIRED.length);
    expect(ours.filter((tag) => tag !== E2E_TAG && !tag.startsWith(`${E2E_TAG}-`)), 'the spec carries another screen’s tag').toEqual([]);
    for (const [tag] of REQUIRED) {
      expect(ours, `no journey carries ${tag}`).toContain(tag);
    }
    expect([...new Set(ours)].filter((tag) => tag !== E2E_TAG && !REQUIRED.some(([required]) => required === tag)), 'the spec carries a tag the suite does not read').toEqual([]);
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
// 7. The browser — one run of @p28-duplicates
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0097 e2e run did not start', outcomes: undefined, startedAt: 0 };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

function outcomes(): E2eOutcome[] {
  expect(e2eRun.outcomes, `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-6000)}`).toBeDefined();
  return e2eRun.outcomes ?? [];
}

describe('acceptance: T-0097 — the duplicates and merge screen in a browser', () => {
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

  it('runs every @p28-duplicates journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(journeys.length, 'the run reported fewer @p28-duplicates tests than there are behaviours').toBeGreaterThanOrEqual(REQUIRED.length);
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p28-duplicates tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter((outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag));
      expect(proving.length, `no PASSING @p28-duplicates test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('pins /contacts/duplicates at or under 255,000 bytes and within 5% of what this run measured (I17)', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'DUPLICATES_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /contacts/duplicates budget is above its ceiling').toBeLessThanOrEqual(DUPLICATES_BUDGET_CEILING);
    expect(budget).toBeLessThan(PRD_CEILING_BYTES);
    const record = fromRoot(BUDGET_RECORD);
    expect(existsSync(record), 'the budget test wrote no measurement').toBe(true);
    expect(statSync(record).mtimeMs, 'the measurement is older than this run').toBeGreaterThanOrEqual(e2eRun.startedAt);
    const measured = (JSON.parse(readFileSync(record, 'utf8')) as { transferredBytes: number }).transferredBytes;
    expect(measured, 'the measurement is empty').toBeGreaterThan(0);
    expect(budget, `the budget is under the ${measured} bytes measured`).toBeGreaterThanOrEqual(measured);
    expect(budget, `the budget is more than 5% over the ${measured} bytes measured — the lead re-pins DUPLICATES_BUDGET_BYTES`).toBeLessThanOrEqual(Math.round(measured * BUDGET_HEADROOM));
  });
});
