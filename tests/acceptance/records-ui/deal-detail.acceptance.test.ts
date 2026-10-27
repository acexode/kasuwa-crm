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
 * ACCEPTANCE — T-0110, the P06 deal detail, frames P06/05 and P06/06 (Agent
 * 11, Frontend & Design System), with T-0111's timeline on it. Decisions:
 * D-L88, D-L102, D-L115, D-L124, D-L127, D-L129, D-L130, D-P23, D-L84, D-L63,
 * D-L69, D-P19, D-P21, D-L118. Written by the lead's QA agent before the
 * screen exists (D-L23).
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. `/deals/[dealId]` behind `crm_pipeline` (T-0109's flag: registered,
 *      DEFAULT OFF, NOT production-ready, read on the server through
 *      `lib/feature-flags.ts`): with every flag at its default it is a real
 *      404; no client module names the flag.
 *   2. The e2e harness's `webPipelineUrl` (T-0109's wiring) serves it.
 *   3. The browser reads getDeal, getPipeline, listDealTimeline and writes
 *      updateDeal, moveDeal and createActivity (with `dealId`) same-origin,
 *      Zod-parsed, with no scope argument; money is never a JS number and no
 *      currency symbol is written into the slice.
 *   4. P06/05 and P06/06 against the contract mock, by e2e tag (section 7):
 *      header and fields, money, dates, links, locks, checks, the edit and
 *      its 409 rebase, assign to me, moves, the timeline and its paging and
 *      field security, logging an activity, not found, states, offline, the
 *      design's out-of-contract features hidden, 360 px, en-XA, the budget,
 *      and T-0109's R15 (the board card links its deal).
 *   5. i18n: the literal-string rule fires on the route; every message id
 *      the slice names is in every design-menu catalogue, with a label for
 *      each timeline field, a former owner, a former checker and
 *      `field_not_editable`; every error the operations answer is localised
 *      as `records.error.<code>`.
 *   6. No colour literal (wider than the lint rule, D-L84) and no
 *      device-storage API in the slice.
 *   7. The contract carries the lead's D-L127 edit: `DealActor.displayName`
 *      may be `null` (a former checker).
 *
 * PINNED INTERFACES (the builder's side): the DOM hooks listed in the header
 * of `tests/e2e/p06-deal.spec.ts`; the route file
 * `apps/web/app/(group)/deals/[dealId]/page.tsx`; a P06/05 screen in the
 * slice (`data-screen="P06/05"`); labels under ids containing `deal` or
 * `pipeline` ending `.field.<each DealFieldChangedItem field>` and
 * `.field_not_editable` (or `.fieldNotEditable`); a former-checker label
 * under an id ending `.checker.former`, `.formerChecker`, `.former_checker`,
 * `.checkedBy.former`, `.member.former` or `.formerMember` (never the
 * former-owner label); `records.owner.former`; `records.error.<code>` for
 * every error code of the operations; `notFound.title` and `notFound.body`.
 *
 * RULINGS (R1–R22; where the task file, the contract or the design leave a
 * choice open, the suite is written to these)
 *
 *   R1. Route. `/deals/[dealId]` calls `notFound()` when `crm_pipeline` is
 *       off and for an id that is not a uuid: a real 404 that reads nothing.
 *       A well-formed id answers 200 and the BROWSER reads the deal (the
 *       server never does), so a deal out of scope or missing is the generic
 *       not-found page (D-L69: `notFound.title`, `notFound.body`,
 *       `[data-testid="record-not-found"]`), identical for both, drawn after
 *       getDeal's 404. This is also what keeps T-0109's "no link on the page
 *       is a 404" true once every card links its deal.
 *   R2. Shell. The CRM shell; the Deals entry (`/pipelines`) is current; a
 *       breadcrumb links the deal's pipeline by name; the document title
 *       never carries the deal's name (`name` is pii, D-L91; D-L63).
 *   R3. Harness. `webPipelineUrl`, as T-0109 wires it. This suite starts no
 *       process of its own and names no flag in the runner.
 *   R4. Reads. getDeal, getPipeline of the deal's own pipeline (stage names,
 *       requirement labels, the allow-list), listDealTimeline,
 *       getCurrentUser (the caller's id, for R11) and the pickers. Nothing
 *       else: no board or list read, no updateActivity.
 *   R5. Money as T-0109 R5 and R6: the served amount and weighted amount,
 *       exact, in Intl's currency format for the page's language, never
 *       compact, never through a JS number, never recomputed (half-even per
 *       deal is the server's).
 *   R6. Dates. The expected close date is a calendar date with no zone: drawn
 *       as served in every browser zone (Cabo Verde, UTC-1, is in the
 *       journeys), in `<time datetime="YYYY-MM-DD">`. Instants (checks, the
 *       timeline) in the browser's zone.
 *   R7. Stage. The current stage's name; a stage path of every open stage
 *       then won, in position order, the current one `aria-current="step"`;
 *       lost is never a step and a lost deal marks none; the CURRENT stage's
 *       requirements listed met or unmet (a requirement can be unmet in the
 *       current stage when it was configured after the deal entered), a field
 *       requirement on a withheld field a lock, never met or unmet.
 *   R8. Checks. Every served check in served order: the label from
 *       getPipeline word for word, who ticked it (`checkedBy.displayName`;
 *       `null` is a translated former-checker label, distinct from the
 *       former-owner one, D-L127) and when. A check whose requirement is no
 *       longer configured still says who and when, and never prints its id.
 *   R9. Locks. A withheld field (with its companion: `weightedAmount`,
 *       `owner`, `contact`, `account`) is a lock with the lock icon, never
 *       blank, zero or a number. `name` is never withheld and never a lock.
 *       A `null` is "not set", never a lock. A former owner is
 *       `records.owner.former`; unassigned is its own words.
 *   R10. Edit. A sheet sends `version` plus ONLY what the person changed
 *       (D-L102), judged against the deal it was opened on: retyping the value
 *       the deal holds is no change. An emptied close date, amount or next
 *       step and a cleared contact or account send `null`. A blank name is a
 *       local, translated error and nothing is sent. The amount is typed as
 *       T-0109 R7 (major units, text input), the currency one of the four.
 *       The contact and account come from pickers offering only the deal's
 *       programme (filtered on the client, as T-0109's follow-up notes). A
 *       withheld field is not offered. After a 200 the sheet closes and the
 *       screen draws the served answer.
 *   R11. Reassign. Only "assign to me" (`[data-action="assign-to-me"]`, on
 *       the screen), offered when the caller is not the owner (unassigned and
 *       a former owner included) and `ownerUserId` is not withheld; it sends
 *       exactly `{ version, ownerUserId: <the caller> }`. No owner picker, no
 *       unassign, no other person: the API refuses those to every caller
 *       without `deal.reassign` (`403 owner_not_self`), and there is neither a
 *       capability read (T-0079) nor a member directory to tell who may, so
 *       offering them would offer what the API refuses. An action-level 403
 *       (an agent on a colleague's deal) is D-L84's gate, drawn as a message.
 *   R12. 409 stale_write. On an edit: the screen re-reads getDeal and the
 *       sheet stays open as the fresh row with the person's edits re-applied;
 *       a field both changed keeps the typed value with
 *       `[data-conflict="<field>"]`; an untouched field shows the fresh value
 *       and is never sent; the person saves again; nothing is resent by
 *       itself. On a move, T-0109 R11.
 *   R13. Refusals. `403 field_not_editable` names the fields by their labels,
 *       inside the sheet or the prompt; `403 not_permitted` is translated;
 *       neither is retried; the sheet and what was typed stay.
 *   R14. Moves. T-0109's move sheet (`[data-action="move-deal"]` on the
 *       screen) and prompt, with T-0109's hooks and rules R9–R11; the detail
 *       then draws the served answer. The design's "Move to …", "Back to …"
 *       and "Mark as lost" shortcuts are the builder's choice, through the
 *       same moveDeal and the same rules.
 *   R15. After every successful write (edit, assign, move, activity) the
 *       timeline's first page is re-read, and the timeline is what it serves:
 *       never spliced from a write's answer (field security decides what
 *       appears on it, D-L129 R5).
 *   R16. Timeline. Items in served order, once each; a field change by the
 *       field's translated name only, never a value and never a stage name
 *       (T-0111 R8); actors by name, `null` as one "System" label, a former
 *       member named (D-L81); activities by translated type with subject,
 *       body, due time and meeting times in the browser's zone; keyset "load
 *       older" echoing the cursor, out of the URL, no total. Completing a task
 *       from the deal timeline is not in T-0110 (updateActivity is a
 *       violation here).
 *   R17. Activities. Note, task and call, linked with `dealId` and targeted at
 *       exactly the deal's served `primaryContactId` (as `contactId`) and
 *       `accountId`, both when both, never a withheld one. A deal with neither
 *       (or neither visible) offers no composer, and
 *       `[data-testid="activity-no-target"]` says why: D-L129's open item. A
 *       403 (a reader; the activity's deal link withheld, `field_not_editable`
 *       at `dealId`) is a translated message in the form, the typing kept,
 *       never retried. With the link write-only the create succeeds and
 *       nothing is drawn that the timeline does not serve.
 *   R18. Hidden: AI deal risk, products and price books, the FX lock and every
 *       US$ figure, VAT and totals, quotes, approvals, contact roles,
 *       competitors, the forecast category, the deal type, territory, lead
 *       source, the deal number, attachments, WhatsApp and email items, Undo.
 *   R19. Offline as T-0109 R17: memory only; every write control disabled;
 *       nothing queued or stored.
 *   R20. Budget: DEAL_BUDGET_BYTES is a 252,000-byte PLACEHOLDER under a
 *       260,000-byte ceiling; the lead pins it within 5% of the builder's
 *       first green measurement (D-L118). Until then the budget test fails by
 *       design.
 *   R21. Write controls show to every caller (D-L84), except where the screen
 *       KNOWS the API refuses: a withheld field is never an input, "assign to
 *       me" is not offered on the caller's own deal or with the owner
 *       withheld, and there is no composer without a target.
 *   R22. Contract (lead edit, this branch, D-L127): `DealActor.displayName`
 *       is `[string, null]`; `null` is a former checker. The API still names
 *       a former checker until a follow-up serves it, so the screen accepts
 *       both. T-0109's spec was re-pinned for R15 in the same branch.
 *
 * BUILDER'S CHOICES: the layout; whether the dialogs load on first open
 * (`next/dynamic`); whether the move sheet and prompt are shared with
 * `/pipelines` (they may be, and then sit in both slices); the design's move
 * shortcuts; where the deal client lives (a `lib/` module); the copy.
 *
 * THE SLICE. Every apps/web module the `deals` route directory imports,
 * transitively by relative import, except the shared shells
 * (`components/auth`, `components/crm`, `components/admin`). It must contain
 * the P06/05 screen itself.
 *
 * NOT HELD HERE, AND WHY
 *   - The API's former-checker `null` (R22): a follow-up API task with its own
 *     suite. The mock serves it; the screen must draw it.
 *   - Reassigning to someone else and unassigning (R11): wait for T-0079 and a
 *     member directory.
 *   - Completing tasks, editing or relinking activities from the deal (R16).
 *   - Attachments, products, quotes and D-L88's hidden list.
 *
 * THE BROWSER HALF. `tests/e2e/p06-deal.spec.ts` (journeys),
 * `tests/e2e/support/deal-mock.ts` (this screen's contract mock) and
 * `tests/e2e/support/pipeline-mock.ts` (T-0109's, which the deal mock
 * imports) are PINNED by hash below, because `tests/e2e` is not
 * path-protected (D-L64). DEAL_BUDGET_BYTES is the one line that may change
 * without a re-pin.
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p06-deal --reporter=list,<ours>
 *
 * spawned with `shell: false` and the arguments as an array (D-L62). Every
 * test is read from the outcomes file our reporter writes, so a skipped,
 * `fixme`d or unmatched test never counts. No other spec's tag contains
 * `@p06-deal`, and it contains no other screen's parent tag (section 6).
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const FLAG = 'crm_pipeline';
/** The flags of the records process that `crm_pipeline` rides on. */
const RECORDS_PROCESS_FLAGS = ['crm_records', 'crm_accounts', 'crm_record_view'];

const E2E_TAG = '@p06-deal';

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
  '@harness',
];

/** `next build` (SWC wasm on the dev host, D-L62), a container, the servers and the journeys. */
const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p06-deal.spec.ts';
const MOCK = 'tests/e2e/support/deal-mock.ts';
const PIPELINE_MOCK = 'tests/e2e/support/pipeline-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/p06-deal-budget.json';
const CONTRACT = 'docs/api/records.openapi.yaml';

/**
 * The pinned browser half (CRLF folded to LF; the budget literal normalised).
 * A change to any of these files is a change to the acceptance contract: the
 * lead re-pins it, the builder does not. The pipeline mock's pin is the one
 * T-0109's suite holds too.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  [SPEC]: 'a521b2d894688d08a969dcb1e171f9546eb97227cdf3e202ead827ba70334614',
  // T-0091 (lead re-pin): both mocks answer listCustomFields (empty unless a journey sets custom fields) and carry `custom`.
  [MOCK]: 'd769f726196d23913a0b844885a836499c780aa2f0df04fa8483f50c763b7a10',
  [PIPELINE_MOCK]: '20923d649ca30d0c10914ead6aacba16a2267620efd4c253dbc10e18de9308dc',
};

/** Never above this (R20). */
const DEAL_BUDGET_CEILING = 290_000; // D-L203: T-0145 measured, after removing the weight it could (no visual change)

/** Re-pinned within 5% of what the run measured (D-L118). */
const BUDGET_HEADROOM = 1.05;

const PRD_CEILING_BYTES = 300 * 1024;

/** The operations the screen calls, for the error-localisation check. */
const OPERATIONS: readonly (readonly [path: string, method: string])[] = [
  ['/api/v1/deals/{dealId}', 'get'],
  ['/api/v1/deals/{dealId}', 'patch'],
  ['/api/v1/deals/{dealId}/move', 'post'],
  ['/api/v1/deals/{dealId}/timeline', 'get'],
  ['/api/v1/pipelines/{pipelineId}', 'get'],
  ['/api/v1/activities', 'post'],
  ['/api/v1/contacts', 'get'],
  ['/api/v1/accounts', 'get'],
];

/** The operations whose `x-kasuwa-screens` must name the deal detail. */
const DETAIL_OPERATIONS: readonly (readonly [path: string, method: string])[] = [
  ['/api/v1/deals/{dealId}', 'get'],
  ['/api/v1/deals/{dealId}', 'patch'],
  ['/api/v1/deals/{dealId}/move', 'post'],
  ['/api/v1/deals/{dealId}/timeline', 'get'],
];

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the mock's validators
  // reject malformed requests and answers, so every afterEach "no violations"
  // and "no mock faults" means something.
  ['@p06-deal-mock', 'the contract mock refuses what the contract and the screen’s rules refuse, and checks its own answers'],
  // Passes before the work starts too (there is no route at all): a negative
  // invariant, given meaning by @p06-deal-flag-on.
  ['@p06-deal-flag-off', '/deals/<id> is a 404 with crm_pipeline at its default, and the browser cannot flip it'],
  ['@p06-deal-flag-on', '/deals/<id> renders the deal with crm_pipeline on'],
  ['@p06-deal-shell', 'the CRM shell, Deals current, the breadcrumb to the pipeline, no name in the title, no link a 404'],
  ['@p06-deal-board-link', 'every board card’s name links its deal, and the link opens the detail (T-0109 R15)'],
  ['@p06-deal-header', 'name, stage, path, current requirements, money, close date, owner, contact, account, next step; axe-clean'],
  ['@p06-deal-money', 'every amount exact in its currency’s Intl format, as served, past 2^53, never recomputed'],
  ['@p06-deal-dates', 'the close date is the served calendar date in a zone west of UTC'],
  ['@p06-deal-links', 'summaries link only from well-formed uuids; markup is text; no id printed'],
  ['@p06-deal-locked', 'withheld fields are locks; name never; null is not a lock; a former owner; nothing to log against'],
  ['@p06-deal-checks', 'who ticked each check and when; a former checker unnamed (D-L127); no id for an unconfigured check'],
  ['@p06-deal-edit', 'version plus only what changed, null to clear, the programme’s picker, the served answer drawn'],
  ['@p06-deal-edit-stale', '409 re-reads and rebases (D-L102), through two 409s, an untouched field never sent'],
  ['@p06-deal-edit-refused', 'field_not_editable names fields, not_permitted translated, typing kept, never retried, no withheld input'],
  ['@p06-deal-reassign', 'assign to me only where it applies, exactly the caller; no other owner; an agent’s 403 a message'],
  ['@p06-deal-move', 'the move sheet offers the allow-list, lost included, by pointer and keyboard; detail and timeline follow'],
  ['@p06-deal-requirements', 'the prompt: met shown met, the rest filled and sent in the move; the checks follow; the picker’s programme'],
  ['@p06-deal-unmet', '422 names requirements by label, learnt by re-reading the pipeline; never retried'],
  ['@p06-deal-move-refused', '409 transition and 403s translated, never retried; a withheld required field is a lock'],
  ['@p06-deal-move-stale', 'a stale move rebases the prompt; a prompt-less stale move is not resent'],
  ['@p06-deal-timeline', 'items once, served order, field changes by name only, actors, the system, activity types and times'],
  ['@p06-deal-timeline-paging', 'keyset "load older", the cursor echoed and out of the URL, no total'],
  ['@p06-deal-timeline-withheld', 'a withheld deal link: no activities and a refused link; write-only not drawn; no invented items'],
  ['@p06-deal-log', 'note, task and call linked with dealId and the deal’s own targets, on the re-read timeline'],
  ['@p06-deal-log-no-target', 'no contact and no account: no composer, and the screen says why (D-L129)'],
  ['@p06-deal-log-refused', 'a refused activity is translated; the form and typing kept; nothing added'],
  ['@p06-deal-not-found', 'out of scope and missing are the plain not-found page; a malformed id a real 404 that reads nothing'],
  ['@p06-deal-states', 'loading, failed, failed timeline and empty timeline kept apart'],
  ['@p06-deal-offline', 'offline: every write disabled, nothing queued, sent or stored'],
  ['@p06-deal-hidden', 'none of the design’s out-of-contract features'],
  ['@p06-deal-mobile', '360 px: no sideways page scroll, axe-clean, the move sheet works'],
  ['@p06-deal-pseudo', 'en-XA renders pseudo text on the deal, the sheets, the prompt and the form'],
  ['@p06-deal-budget', '/deals/[dealId] inside its byte budget on the production build'],
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

const DEAL_ROUTE = /^apps\/web\/app\/(?:\([\w-]+\)\/)*deals\/\[dealId\]\/page\.tsx$/;

function routePage(): string | undefined {
  return trackedFiles('apps/web/app').find((file) => DEAL_ROUTE.test(file));
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Shared shells other suites hold; not part of this slice. */
const SHARED_SHELLS = ['apps/web/components/auth/', 'apps/web/components/crm/', 'apps/web/components/admin/'];

/**
 * The slice: every file in the `deals` route directory, and everything they
 * import by a relative path, transitively, minus the shared shells.
 */
function sliceSources(): SourceFile[] {
  const page = routePage();
  if (page === undefined) return [];
  const directory = posix.dirname(posix.dirname(page));
  const sources = new Map(webSources().map((entry) => [entry.file, entry.source]));
  const queue = [...sources.keys()].filter((file) => file.startsWith(`${directory}/`));
  const seen = new Set<string>();
  const resolveImport = (from: string, specifier: string): string | undefined => {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    return [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) => sources.has(candidate));
  };
  while (queue.length > 0) {
    const file = queue.shift() ?? '';
    if (seen.has(file) || SHARED_SHELLS.some((shell) => file.startsWith(shell))) continue;
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

/** The slice, refused unless the route exists and the slice contains the P06/05 screen itself. */
function screenSlice(): SourceFile[] {
  expect(routePage(), 'there is no apps/web/app/**/deals/[dealId]/page.tsx').toBeDefined();
  const slice = sliceSources();
  expect(
    slice.filter(({ source }) => /['"`]P06\/05['"`]/.test(withoutComments(source))).map(({ file }) => file),
    'the /deals route imports no P06/05 screen (data-screen="P06/05")',
  ).not.toEqual([]);
  return slice;
}

/** apps/web/lib modules that call the deals, pipelines or activities API. */
function dealClients(): SourceFile[] {
  return webSources().filter(
    ({ file, source }) => file.startsWith('apps/web/lib/') && /\/api\/v1\/(deals|pipelines|activities)\b/.test(withoutComments(source)),
  );
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8')) as Record<string, string>;
}

const BUDGET_LITERAL = /const DEAL_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8').replace(/\r\n/g, '\n').replace(BUDGET_LITERAL, 'const DEAL_BUDGET_BYTES = <budget>;');
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

function enumAt(schemaName: string, ...path: string[]): string[] {
  let node: unknown = contract().components.schemas[schemaName];
  for (const segment of path) node = (node as Json | undefined)?.[segment];
  return Array.isArray(node) ? node.map(String) : [];
}

/** Colour written into a web source rather than read from a token (T-0109's detector, D-L84). */
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

/** A currency symbol in the source, or an amount through Number/parseFloat/parseInt (T-0109 R5). */
function moneyHazards(source: string): string[] {
  const code = withoutComments(source);
  return [
    ...(code.match(/[₦₵¢]|GH₵|\bK[Ss]h\b/g) ?? []),
    ...(code.match(/\b(?:Number|parseFloat|parseInt)\s*\(\s*[\w.?![\]]*(?:amountMinor|weightedAmountMinor)\b/g) ?? []),
  ];
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

/** en.json ids about deals or pipelines ending with one of `suffixes`. */
function dealKey(en: Record<string, string>, suffixes: readonly string[]): string | undefined {
  return Object.keys(en).find((id) => /deal|pipeline/i.test(id) && suffixes.some((suffix) => id.endsWith(suffix)));
}

const FORMER_CHECKER_KEY = /\.checker\.former$|\.formerChecker$|\.former_checker$|\.checkedBy\.former$|\.member\.former$|\.formerMember$/;

// ===========================================================================
// 1. The flag, the route, the harness and the client
// ===========================================================================

describe('acceptance: T-0110 — /deals/[dealId] is behind crm_pipeline, served by the records process, through a scoped client', () => {
  it('crm_pipeline is registered, not production-ready, and evaluates OFF by default', async () => {
    // `true` as the fallback on purpose: an unregistered flag returns the
    // fallback, so only a flag that is registered AND defaults off answers false.
    expect(Object.keys(FLAGS), `${FLAG} is not declared in FLAGS (T-0109 registers it)`).toContain(FLAG);
    const definition = (FLAGS as Readonly<Record<string, { productionReady?: boolean; defaultValue?: boolean }>>)[FLAG];
    expect(definition?.defaultValue, `${FLAG} does not default off`).toBe(false);
    expect(definition?.productionReady, `${FLAG} is marked production-ready`).toBe(false);
    await initialiseFeatureFlags();
    const value = await featureFlagClient().getBooleanValue(FLAG, true, toEvaluationContext({ tenantId: 'acceptance-probe' }));
    expect(value, `${FLAG} does not evaluate OFF by default`).toBe(false);
  });

  it('has the route file, calling notFound() on crm_pipeline, read on the server only (R1)', () => {
    const page = routePage();
    expect(page, 'there is no apps/web/app/**/deals/[dealId]/page.tsx').toBeDefined();
    const source = withoutComments(readFileSync(fromRoot(page ?? 'missing'), 'utf8'));
    expect(source, `${page} does not call notFound()`).toMatch(/\bnotFound\s*\(/);
    expect(source, `${page} imports nothing from lib/feature-flags`).toMatch(/from ['"][./]*lib\/feature-flags['"]/);
    const readers = readersOf(FLAG).filter((name) => name !== 'crmLiveNav');
    const gated = readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source)) || new RegExp(`['"]${FLAG}['"]`).test(source);
    expect(gated, `${page} is not gated on ${FLAG} (readers found: ${readers.join(', ') || 'none'})`).toBe(true);
    const clientEvaluators = webSources().filter(({ source: code }) => /^\s*['"]use client['"]/m.test(code) && code.includes(FLAG));
    expect(clientEvaluators.map(({ file }) => file), 'a client module names crm_pipeline — flags are read on the server only').toEqual([]);
  });

  it('is served by the records process with crm_pipeline on, at webPipelineUrl, leaving the default server flagless (R3)', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    const processes = [...runner.matchAll(/KASUWA_FEATURE_FLAGS_ON:\s*['"`]([^'"`]*)['"`]/g)].map((match) => (match[1] ?? '').split(/[,\s]+/));
    expect(
      processes.some((flags) => flags.includes(FLAG) && RECORDS_PROCESS_FLAGS.every((flag) => flags.includes(flag))),
      `no web process in run-e2e.mjs carries ${FLAG} beside ${RECORDS_PROCESS_FLAGS.join(', ')} (T-0109's wiring)`,
    ).toBe(true);
    expect(runner, 'run-e2e.mjs does not publish webPipelineUrl in the stack file').toContain('webPipelineUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*''/);
  });

  it('updates deals, reads the deal timeline and links activities to deals through apps/web/lib, same-origin, Zod-parsed, unscoped, with no test support', () => {
    const clients = dealClients();
    const naming = (pattern: RegExp) => clients.filter(({ source }) => pattern.test(withoutComments(source))).map(({ file }) => file);
    expect(
      clients.filter(({ source }) => /\/api\/v1\/deals\b/.test(withoutComments(source)) && /['"`]PATCH['"`]/.test(withoutComments(source))).map(({ file }) => file),
      'no apps/web/lib module sends PATCH /api/v1/deals/{id} (updateDeal)',
    ).not.toEqual([]);
    expect(naming(/\/api\/v1\/deals\/[^'"`]*\/timeline|\/timeline['"`]/), 'no apps/web/lib module reads the deal timeline').not.toEqual([]);
    expect(
      clients.filter(({ source }) => /\/api\/v1\/activities\b/.test(withoutComments(source)) && /\bdealId\b/.test(withoutComments(source))).map(({ file }) => file),
      'no apps/web/lib module creates an activity with dealId',
    ).not.toEqual([]);
    for (const { file, source } of clients) {
      const code = withoutComments(source);
      expect(code, `${file} names an absolute API origin`).not.toMatch(/https?:\/\/[^'"`]*\/api\/v1/);
      expect(code, `${file} does not parse with Zod`).toMatch(/from ['"]zod['"]/);
      expect(code, `${file} builds a scope argument`).not.toMatch(/programmeIds|(set|append)\(\s*['"`]programme|['"`]x-[\w-]*(programme|tenant)/i);
    }
    for (const { file: name, source } of webSources()) {
      expect(withoutComments(source), `${name} imports test support`).not.toMatch(/from ['"][^'"]*(tests\/e2e|deal-mock|pipeline-mock|records-mock|@kasuwa\/testing)[^'"]*['"]/);
    }
  });

  it('writes no currency symbol and never makes a JS number of an amount, in the slice or the client (R5)', () => {
    const found = [...screenSlice(), ...dealClients()].flatMap(({ file, source }) => moneyHazards(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'money is formatted by hand or parsed into a JS number — use Intl with the string, or BigInt').toEqual([]);
  });
});

// ===========================================================================
// 2. i18n — the lint rule, every catalogue, D-P1
// ===========================================================================

describe('acceptance: T-0110 — every string through i18n, in every catalogue, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the deal’s route file', () => {
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(/files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/);
    // A rule only ever seen passing proves nothing: plant a literal at the route's own path.
    const page = routePage();
    expect(page, 'there is no apps/web/app/**/deals/[dealId]/page.tsx').toBeDefined();
    const planted = eslint(
      ['--stdin', '--stdin-filename', page ?? 'apps/web/app/deals/[dealId]/page.tsx', '--format', 'json'],
      'export default function Planted() {\n  return <p>Assign to me</p>;\n}\n',
    );
    expect(planted.output, `a literal JSX string at ${page} is not rejected:\n${planted.output.slice(-2000)}`).toContain('i18next/no-literal-string');
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const slice = screenSlice();
    const run = eslint(['--max-warnings', '0', ...slice.map(({ file }) => file)]);
    expect(run.status, `eslint fails on the deal slice:\n${run.output.slice(-4000)}`).toBe(0);
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('puts every message the slice names, and a label for each timeline field, a former owner, a former checker and field_not_editable, in every design-menu catalogue', async () => {
    const i18n: { DESIGN_MENU_LOCALES: readonly string[] } = await import(fromRoot('packages/i18n/src/index.ts'));
    const en = catalogue('en');
    const slice = screenSlice();
    const named = new Set<string>();
    for (const { source } of slice) {
      for (const match of withoutComments(source).matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)) {
        if (match[1] !== undefined && en[match[1]] !== undefined) named.add(match[1]);
      }
    }
    // Vacuity guard: a slice that names almost no catalogue key is not using i18n.
    expect(named.size, 'the deal slice names almost no message id').toBeGreaterThan(20);

    const find = (what: string, key: string | undefined): string => {
      expect(key, `en.json has no label for ${what}`).toBeDefined();
      return key ?? `<missing ${what}>`;
    };
    const fields = enumAt('DealFieldChangedItem', 'properties', 'field', 'enum');
    expect(fields, 'the deal timeline’s field names changed').toEqual(['name', 'amount', 'expectedCloseDate', 'ownerUserId', 'primaryContactId', 'accountId', 'nextStep', 'stageId', 'checks']);
    const fieldKeys = fields.map((name) => find(`the ${name} field (an id about deals or pipelines ending ".field.${name}")`, dealKey(en, [`.field.${name}`])));
    const refusalKey = find('field_not_editable (an id about deals or pipelines ending ".field_not_editable" or ".fieldNotEditable")', dealKey(en, ['.field_not_editable', '.fieldNotEditable']));
    const formerOwnerKey = find('a former owner (records.owner.former)', en['records.owner.former'] === undefined ? undefined : 'records.owner.former');
    const formerCheckerKey = find('a former checker (an id ending ".checker.former", ".formerChecker", ".former_checker", ".checkedBy.former", ".member.former" or ".formerMember")', Object.keys(en).find((id) => FORMER_CHECKER_KEY.test(id)));
    expect(en[formerCheckerKey], 'the former checker is labelled as a former owner (D-L127)').not.toBe(en[formerOwnerKey]);
    const typeKeys = ['note', 'task', 'call', 'meeting'].map((type) => find(`the ${type} activity type`, Object.keys(en).find((id) => /activit/i.test(id) && id.endsWith(`.type.${type}`))));
    const notFoundKeys = ['notFound.title', 'notFound.body'].map((key) => find(key, en[key] === undefined ? undefined : key));

    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const key of [...named, ...fieldKeys, refusalKey, formerOwnerKey, formerCheckerKey, ...typeKeys, ...notFoundKeys]) {
        if (typeof messages[key] !== 'string' || messages[key].trim() === '') missing.push(`${locale}: ${key}`);
      }
    }
    expect(missing, 'message ids the deal screen uses that a catalogue lacks').toEqual([]);
  });

  it('localises every error the deal detail’s operations can answer with', () => {
    const en = catalogue('en');
    const codes = new Set(OPERATIONS.flatMap(([path, method]) => errorCodes(path, method)));
    // Vacuity guard: the writes' own refusals must be among them.
    expect([...codes], 'the operations declare no error codes').toEqual(
      expect.arrayContaining(['not_found', 'not_permitted', 'stale_write', 'transition_not_allowed', 'requirements_unmet', 'validation_failed', 'not_authenticated']),
    );
    const missing = [...codes].filter((code) => en[`records.error.${code}`] === undefined);
    expect(missing, 'en.json lacks records.error.<code> for these errors').toEqual([]);
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
// 3. Colour, money hazards and the device
// ===========================================================================

describe('acceptance: T-0110 — no colour literal and no device storage in the slice', () => {
  it('the colour and money detectors catch what the lint rule misses', () => {
    // Planted first: a detector only ever seen finding nothing proves nothing.
    // Passes before the work starts, by design.
    for (const planted of ['className="text-[#c00] p-2"', "style={{ color: 'red' }}", 'className="bg-amber-100"', "const tint = 'color-mix(in oklch, var(--k-danger) 18%, var(--k-surface))';", 'className="border-white"']) {
      expect(colourLiterals(planted), `the colour detector missed ${planted}`).not.toEqual([]);
    }
    expect(colourLiterals('className="bg-surface text-text-2 border-border-strong text-danger-text bg-warning-soft"')).toEqual([]);
    for (const planted of ["const label = '₦' + amount;", 'const cedi = `GH₵${value}`;', "const shilling = 'KSh ' + value;", 'const major = Number(deal.amount.amountMinor) / 100;', 'const weighted = parseInt(deal.weightedAmount?.amountMinor ?? "0", 10);']) {
      expect(moneyHazards(planted), `the money detector missed ${planted}`).not.toEqual([]);
    }
    expect(moneyHazards("new Intl.NumberFormat(locale, { style: 'currency', currency }).format(`${whole}.${fraction}`); BigInt(deal.amount.amountMinor);")).toEqual([]);
  });

  it('the slice reaches the screen through its imports, and stops at the shared shells', () => {
    const slice = screenSlice();
    const files = slice.map(({ file }) => file);
    expect(files).toContain(routePage() ?? '<no deal page>');
    expect(files.filter((file) => SHARED_SHELLS.some((shell) => file.startsWith(shell)))).toEqual([]);
    expect(files.length, 'the slice is the route file alone: nothing it imports was followed').toBeGreaterThan(1);
  });

  it('writes no colour literal anywhere in the slice', () => {
    const found = screenSlice().flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the deal slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('touches no device-storage API (D-L64, D-P21)', () => {
    const storage = /\b(localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|navigator\.storage|document\.cookie)\b/;
    const found = [...screenSlice(), ...dealClients()].filter(({ source }) => storage.test(withoutComments(source))).map(({ file }) => file);
    expect(found, 'the deal slice uses a device-storage API: the deal lives in memory only').toEqual([]);
  });
});

// ===========================================================================
// 4. The contract this screen is written against (R22)
// ===========================================================================

describe('acceptance: T-0110 — the records contract carries what the deal detail needs', () => {
  it('a former checker may be unnamed: DealActor.displayName is nullable, citing D-L127 (the lead edit)', () => {
    // Passes before the work starts: it pins the lead's contract edit in this branch.
    const actor = contract().components.schemas.DealActor as { description?: string; properties?: Record<string, { type?: unknown }> };
    expect(actor.properties?.displayName?.type, 'DealActor.displayName is not [string, null]').toEqual(['string', 'null']);
    expect(String(actor.description), 'DealActor no longer says why its name may be null').toMatch(/D-L127/);
    const owner = contract().components.schemas.DealOwner as { properties?: Record<string, { type?: unknown }> };
    expect(owner.properties?.displayName?.type, 'DealOwner.displayName is no longer nullable (D-P23)').toEqual(['string', 'null']);
  });

  it('the deal operations are served and name the deal detail’s frames', () => {
    // Passes before the work starts: T-0108 and T-0111 serve them.
    const spec = contract();
    for (const [path, method] of DETAIL_OPERATIONS) {
      const operation = spec.paths[path]?.[method];
      expect(operation, `${method.toUpperCase()} ${path} is gone`).toBeDefined();
      expect(operation?.['x-kasuwa-implemented'], `${method.toUpperCase()} ${path} is not served`).toBe(true);
      expect(operation?.['x-kasuwa-screens'], `${method.toUpperCase()} ${path} does not name P06/05`).toEqual(expect.arrayContaining(['P06/05']));
    }
    const create = spec.components.schemas.CreateActivityRequest as { properties?: Record<string, unknown> };
    expect(Object.keys(create.properties ?? {}), 'createActivity no longer takes dealId').toContain('dealId');
  });
});

// ===========================================================================
// 5. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0110 — the journeys and the mocks are the ones this suite was written with', () => {
  it('pins p06-deal.spec.ts, deal-mock.ts and pipeline-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(normalisedHash(file), `${file} changed. It is part of the T-0110 acceptance contract: ask the lead to re-pin it (only DEAL_BUDGET_BYTES may move without that).`).toBe(pinned);
    }
    const mock = readFileSync(fromRoot(MOCK), 'utf8');
    expect(mock, 'the deal mock no longer builds on the pipeline mock').toContain("from './pipeline-mock'");
    expect(mock, 'the deal mock no longer reads the records contract').toContain('RECORDS_CONTRACT_SOURCE');
    expect(mock, 'the deal mock no longer checks its own answers against the contract').toMatch(/dealAnswerProblems\(operation, status, body\)/);
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    expect(spec, 'the journeys no longer fix the browser clock').toContain('page.clock.setFixedTime(new Date(NOW))');
    expect(BUDGET_LITERAL.test(spec), 'DEAL_BUDGET_BYTES is not where it was').toBe(true);
  });
});

// ===========================================================================
// 6. The tag is this screen's alone (D-L84)
// ===========================================================================

describe('acceptance: T-0110 — @p06-deal selects these journeys and nothing else', () => {
  it('no other spec carries a tag @p06-deal matches, ours matches no other parent tag, and the spec carries only ours', () => {
    // Passes as soon as the spec exists: it guards the screens before and after this one.
    const specs = trackedFiles('tests/e2e').filter((file) => file.endsWith('.spec.ts') && existsSync(fromRoot(file)));
    expect(specs).toContain(SPEC);
    const ours = tagsIn(SPEC);
    expect(ours.length).toBeGreaterThan(REQUIRED.length);
    expect(ours.filter((tag) => tag !== E2E_TAG && !tag.startsWith(`${E2E_TAG}-`)), 'the spec carries another screen’s tag').toEqual([]);
    for (const [tag] of REQUIRED) expect(ours, `no journey carries ${tag}`).toContain(tag);
    const clashes = specs.filter((file) => file !== SPEC).flatMap((file) => tagsIn(file).filter((tag) => new RegExp(E2E_TAG).test(tag)).map((tag) => `${file}: ${tag}`));
    expect(clashes, `--grep ${E2E_TAG} would also run these`).toEqual([]);
    for (const other of OTHER_PARENT_TAGS) {
      expect(new RegExp(other).test(E2E_TAG), `--grep ${other} runs this screen`).toBe(false);
      expect(ours.filter((tag) => new RegExp(other).test(tag)), `--grep ${other} runs these journeys`).toEqual([]);
    }
  });
});

// ===========================================================================
// 7. The browser — one run of @p06-deal
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0110 e2e run did not start', outcomes: undefined, startedAt: 0 };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

function outcomes(): E2eOutcome[] {
  expect(e2eRun.outcomes, `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-6000)}`).toBeDefined();
  return e2eRun.outcomes ?? [];
}

describe('acceptance: T-0110 — the deal detail in a browser', () => {
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
      // A production build plus a Playwright list reporter overflows the 1 MB default.
      maxBuffer: 256 * 1024 * 1024,
    });
    e2eRun = {
      status: run.status,
      output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error === undefined ? '' : `\n[spawn] ${run.error.message}`}`,
      outcomes: existsSync(OUTCOMES_FILE) ? (JSON.parse(readFileSync(OUTCOMES_FILE, 'utf8')) as E2eOutcome[]) : undefined,
      startedAt,
    };
  }, E2E_RUN_TIMEOUT_MS);

  it('runs every @p06-deal journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(journeys.length, 'the run reported fewer @p06-deal tests than there are behaviours').toBeGreaterThanOrEqual(REQUIRED.length);
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p06-deal tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter((outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag));
      expect(proving.length, `no PASSING @p06-deal test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('pins /deals/[dealId] at or under 260,000 bytes and within 5% of what this run measured (R20)', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'DEAL_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /deals/[dealId] budget is above its ceiling').toBeLessThanOrEqual(DEAL_BUDGET_CEILING);
    expect(budget).toBeLessThan(PRD_CEILING_BYTES);
    const record = fromRoot(BUDGET_RECORD);
    expect(existsSync(record), 'the budget test wrote no measurement').toBe(true);
    expect(statSync(record).mtimeMs, 'the measurement is older than this run').toBeGreaterThanOrEqual(e2eRun.startedAt);
    const measured = (JSON.parse(readFileSync(record, 'utf8')) as { transferredBytes: number }).transferredBytes;
    expect(measured, 'the measurement is empty').toBeGreaterThan(0);
    expect(budget, `the budget is under the ${measured} bytes measured`).toBeGreaterThanOrEqual(measured);
    expect(budget, `the budget is more than 5% over the ${measured} bytes measured — the lead re-pins DEAL_BUDGET_BYTES`).toBeLessThanOrEqual(Math.round(measured * BUDGET_HEADROOM));
  });
});
