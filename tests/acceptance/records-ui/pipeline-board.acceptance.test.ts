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
 * ACCEPTANCE — T-0109, the P06 pipeline board and list view, frames P06/01
 * and P06/01b (Agent 11, Frontend & Design System). Decisions: D-L88, D-L102,
 * D-L113, D-L115, D-L123, D-L124, D-L127, D-P19, D-P13, D-P21, D-L97, D-L118.
 * Written by the lead's QA agent before the screen exists (D-L23).
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. `crm_pipeline`: a registered flag, DEFAULT OFF, NOT production-ready,
 *      read on the server through `lib/feature-flags.ts`. `/pipelines` and
 *      `/pipelines/[pipelineId]` call `notFound()` and are gated on it by
 *      name: with every flag at its default both are real 404s. No client
 *      module names it.
 *   2. The CRM nav's Deals entry links `/pipelines`, and only where
 *      `crm_pipeline` is on (`crmLiveNav()`): with the flag off there is no
 *      nav entry (R2).
 *   3. The e2e harness publishes `webPipelineUrl`. `crm_pipeline` RIDES ON THE
 *      RECORDS PROCESS beside `crm_records`, `crm_accounts` and
 *      `crm_record_view`, so the cards' contact and account links resolve; the
 *      default server stays flagless (R3).
 *   4. The browser reads the pipelines and deals API (T-0107, T-0108)
 *      same-origin, Zod-parsed, with no scope argument; no apps/web module
 *      imports test support. Money is never parsed into a JS number and no
 *      currency symbol is written into the slice (R5).
 *   5. P06/01 and P06/01b against the contract mock, by e2e tag (section 6):
 *      the board's columns, exact counts and per-currency totals, column
 *      paging, the won window; the list view's rows, sort keys and keyset
 *      paging with no counts; filters; drag and the move sheet with
 *      `version`; the requirement prompt; 409 transition, 422 requirements and
 *      403 refusals as messages, never retried; a 409 stale write that
 *      rebases (D-L102); create with money as minor-unit strings; locks for
 *      withheld amounts, owners and close dates; rotting from the server;
 *      links only from well-formed uuids; loading, empty and failed kept
 *      apart; offline; the design's out-of-contract features hidden; 360 px;
 *      en-XA; the byte budget.
 *   6. i18n: the literal-string rule fires on the route; every message id the
 *      slice names is in every design-menu catalogue, with a label for the
 *      stale and rotting states, for every requirement field, for a former
 *      owner and for `field_not_editable`; every error the operations answer
 *      is localised as `records.error.<code>`; no language falls off the menu.
 *   7. No colour literal (wider than the lint rule, D-L84) and no
 *      device-storage API in the slice.
 *
 * PINNED INTERFACES (the builder's side): the DOM hooks and the
 * `webPipelineUrl` stack key listed in the header of
 * `tests/e2e/p06-pipeline.spec.ts`; the route files
 * `apps/web/app/(group)/pipelines/page.tsx` and
 * `apps/web/app/(group)/pipelines/[pipelineId]/page.tsx`; a P06/01 screen in
 * the slice (`data-screen="P06/01"`); the nav entry `deals` with href
 * `/pipelines` in `components/crm/crm-nav.ts`; labels under ids containing
 * `deal` or `pipeline` ending `.rotting.stale`, `.rotting.rotting`,
 * `.field.<amount|expectedCloseDate|nextStep|primaryContactId|accountId>` and
 * `.field_not_editable` (or `.fieldNotEditable`); `records.error.<code>` for
 * every error code of the operations.
 *
 * RULINGS (R1–R20; where the task file, the contract or the design leave a
 * choice open, the suite is written to these)
 *
 *   R1. Routes. `/pipelines/[pipelineId]` is the board (P06/01) and the list
 *       view (P06/01b), one route with a view switch. `/pipelines` lists the
 *       caller's pipelines by name (listPipelines), each linking its board,
 *       with an empty state; it is the nav's target. The board's own pipeline
 *       selector (the design's) is the builder's choice.
 *   R2. Nav. The existing Deals entry gets href `/pipelines`, linked only
 *       where `crm_pipeline` is on (`crmLiveNav()`), current on both routes.
 *       No process serves the CRM shell with the flag off, so "no nav entry
 *       with the flag off" is held statically (section 1).
 *   R3. Harness. NOT WIRED BY THIS SUITE: the builder adds `crm_pipeline` to
 *       the records process and `webPipelineUrl` to the stack file in the
 *       same change that registers the flag. Naming an unregistered flag in
 *       KASUWA_FEATURE_FLAGS_ON stops a web process from booting
 *       (`flagConfiguration` throws, `instrumentation.ts` exits), which would
 *       take every records-process suite down on main.
 *   R4. Counts and totals are drawn only as served. The board is read whole
 *       on load (not column by column); after any write it is re-read (whole
 *       or the affected columns). The browser never adds, subtracts, rounds,
 *       converts or sums a count or an amount. No board-level summary ("Open
 *       pipeline", "Weighted", "Won this quarter", "N open deals").
 *   R5. Money is exact: Intl's currency format for the active language
 *       (symbol, narrow symbol or code, never a symbol in the source), the
 *       currency's minor digits, never compact (the design's "₦36.6M" is
 *       overruled by D-P19's exactness), never through a JS number (18-digit
 *       amounts, 24-digit totals).
 *   R6. Weighted amounts and totals are the served strings, never recomputed
 *       (half-even per deal is the server's, D-L88).
 *   R7. Create sends `name` and only the optional fields filled
 *       (`amount` as `{ amountMinor, currency }`, `expectedCloseDate`,
 *       `nextStep`), never `null` for an empty field, never `ownerUserId`
 *       (the caller is the owner by default; reassignment is T-0110's), never
 *       a programme, pipeline or stage. The amount is typed in major units
 *       with "." as the decimal point and at most the currency's minor
 *       digits, in a text input (a number input cannot hold 18 significant
 *       digits faithfully); anything else is a local, translated field error
 *       and nothing is sent. The currency is chosen from NGN, GHS, KES, ZAR. A
 *       field the board says is withheld is not offered.
 *   R8. Rotting is the served `rotting` (fresh, stale, rotting), with
 *       translated labels for stale and rotting; never recomputed from the
 *       design's fixed 7/14 days (Contract rots at 21). Won has none.
 *   R9. Moves. Drag and the move sheet (a button; keyboard alike, WCAG 2.2
 *       SC 2.5.7) send the same moveDeal. The sheet offers exactly the
 *       allow-list's targets from the deal's stage, lost included, the
 *       current stage excluded (others absent or disabled). A target off the
 *       allow-list the screen read is said and never sent. A target whose
 *       requirements the deal does not meet opens the prompt: every target
 *       requirement listed, met ones shown met and not asked, check labels
 *       word for word, field labels translated, withheld required fields as
 *       locks and never filled; it sends `version`, `toStageId` and only what
 *       the person filled. A contact or account requirement is a picker
 *       (listContacts / listAccounts with `q`) offering only records of the
 *       pipeline's programme.
 *   R10. Refusals. 409 transition_not_allowed and 403 not_permitted are
 *       translated messages; 422 names the requirements by label (an id the
 *       screen does not know is learnt by re-reading getPipeline, never
 *       printed); 403 field_not_editable names the field labels. None is
 *       retried; the card ends where the server says.
 *   R11. 409 stale_write. The screen re-reads the deal (getDeal or the board,
 *       its choice); an open prompt stays open with the person's input
 *       re-applied (D-L102: a field both changed keeps the typed value with a
 *       "changed by someone else" note; a field nobody typed is never sent);
 *       the person confirms again. A move with no prompt is not resent by
 *       itself.
 *   R12. Won window. The board starts on 90 days (the server's default, or
 *       the screen's own 90 days) and draws the echoed `closedSince`; the
 *       window control offers whole days, each at most 366, 365 among them.
 *       Open columns ignore it. Lost is never a column; lost deals are in the
 *       list view only.
 *   R13. List view: rows in served order with name, stage name and amount;
 *       sort only by listDeals' keys; amount, close date, owner and stage do
 *       not sort; no count and NO footer totals (the list holds lost deals
 *       the board's totals never cover, so a footer copied from the board
 *       would mislabel them). Desktop only, as the design draws it.
 *   R14. Filters: `q`, owner (me, unassigned, ids), close window, currency
 *       (the four) and the won window, the same on board and list reads; no
 *       filter on a field the board says is withheld; no amount band and no
 *       territory (not in the contract).
 *   R15. The card's name links `/deals/<id>` (T-0110's route), asserted by
 *       T-0110's `@p06-deal-board-link`, which re-pinned this spec so its
 *       link check judges the summaries only. The link must not break the
 *       drag. The card's contact or account summary links only from a
 *       well-formed uuid. No UUID is printed.
 *   R16. A malformed route id is a real 404 that reads nothing; an unknown or
 *       unreachable well-formed id is the in-page not-found after
 *       getPipeline's 404, distinct from a failed read.
 *   R17. Offline: memory only; every write control and every drag disabled;
 *       nothing queued or stored.
 *   R18. Hidden: US$ and FX, territory, the amount band, AI risk, products,
 *       price books and quotes, approvals, attachments, last WhatsApp
 *       contact, contact roles, competitors, the template picker (P06/07),
 *       Undo and the board-level summary.
 *   R19. Budget: PIPELINE_BUDGET_BYTES is a 255,000-byte PLACEHOLDER under a
 *       260,000-byte ceiling; the lead pins it within 5% of the builder's
 *       first green measurement (D-L118). Until then the budget test fails by
 *       design.
 *   R20. Write controls show to every caller (D-L84, the capability-read gap,
 *       T-0079); the API's 403 is the gate and is drawn as a message. The
 *       mock's default caller is a team lead (moves any deal).
 *
 * BUILDER'S CHOICES: the layout; whether the list view and the dialogs load
 * on first open (`next/dynamic`); how the board drags (the platform's drag
 * events or a library, with its one-line justification and room in the
 * budget); the board's pipeline selector; whether a card also shows the
 * weighted amount, days in stage or the next step; where the pipeline client
 * lives (a `lib/` module); the copy.
 *
 * THE SLICE. Every apps/web module the `/pipelines` route directory imports,
 * transitively by relative import, except the shared shells
 * (`components/auth`, `components/crm`, `components/admin`). It must contain
 * the P06/01 screen itself.
 *
 * NOT HELD HERE, AND WHY
 *   - The deal detail and its link (T-0110), the timeline (T-0111), pipeline
 *     configuration and the template picker (no contract), FX (D-L88).
 *   - Leaving won or lost: allowed by the sheet's allow-list and refused by
 *     the API without write-any rights; not driven here.
 *
 * THE BROWSER HALF. `tests/e2e/p06-pipeline.spec.ts` (journeys) and
 * `tests/e2e/support/pipeline-mock.ts` (the contract mock, which checks
 * every answer it gives against the YAML; T-0110 reuses it) were written with
 * this suite and are PINNED by hash below, because `tests/e2e` is not
 * path-protected (D-L64). PIPELINE_BUDGET_BYTES is the one line that may
 * change without a re-pin.
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p06-pipeline --reporter=list,<ours>
 *
 * spawned with `shell: false` and the arguments as an array (D-L62). Every
 * test is read from the outcomes file our reporter writes, so a skipped,
 * `fixme`d or unmatched test never counts. No other spec's tag contains
 * `@p06-pipeline`, and it contains no other screen's parent tag (section 5).
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const FLAG = 'crm_pipeline';
/** The flags of the records process that `crm_pipeline` rides on. */
const RECORDS_PROCESS_FLAGS = ['crm_records', 'crm_accounts', 'crm_record_view'];

const E2E_TAG = '@p06-pipeline';

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
  '@p07',
  '@p10-builder',
  '@p10-agent',
  '@p06-deal',
  '@harness',
];

/** `next build` (SWC wasm on the dev host, D-L62), a container, the servers and the journeys. */
const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p06-pipeline.spec.ts';
const MOCK = 'tests/e2e/support/pipeline-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/p06-pipeline-budget.json';
const CONTRACT = 'docs/api/records.openapi.yaml';

/**
 * The pinned browser half (CRLF folded to LF; the budget literal normalised).
 * A change to either file is a change to the acceptance contract: the lead
 * re-pins it, the builder does not.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  // Re-pinned by the lead in T-0110's suite branch (R15): the hostile card's link check judges its summaries only.
  [SPEC]: 'f227bfa7ed9969ac6d228faa2e7e4c247901a84fd05f9c2d5b16cefd91f96eb1',
  // T-0091 (lead re-pin): the mock answers listCustomFields (empty unless a journey sets custom fields) and listDeals' custom filters.
  [MOCK]: '9822ab4f6f83dff056de35e3e79992ab26a7021d7e5f748f45fc2cd84b6d0a25',
};

/** Never above this (R19). */
const PIPELINE_BUDGET_CEILING = 260_000;

/** Re-pinned within 5% of what the run measured, like /activities (D-L118) and /leads (T-0058). */
const BUDGET_HEADROOM = 1.05;

const PRD_CEILING_BYTES = 300 * 1024;

/** The operations the screen calls, for the error-localisation check. */
const OPERATIONS: readonly (readonly [path: string, method: string])[] = [
  ['/api/v1/pipelines', 'get'],
  ['/api/v1/pipelines/{pipelineId}', 'get'],
  ['/api/v1/pipelines/{pipelineId}/board', 'get'],
  ['/api/v1/pipelines/{pipelineId}/deals', 'get'],
  ['/api/v1/pipelines/{pipelineId}/deals', 'post'],
  ['/api/v1/deals/{dealId}', 'get'],
  ['/api/v1/deals/{dealId}/move', 'post'],
];

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  // Passes before the work starts, by design: it proves the mock's validators
  // reject malformed requests and answers, so every afterEach "no violations"
  // and "no mock faults" means something.
  ['@p06-pipeline-mock', 'the contract mock refuses what the contract and the screen’s rules refuse, and checks its own answers'],
  // Passes before the work starts too (there is no route at all): a negative
  // invariant, given meaning by @p06-pipeline-flag-on.
  ['@p06-pipeline-flag-off', '/pipelines and /pipelines/<id> are 404s with crm_pipeline at its default, and the browser cannot flip them'],
  ['@p06-pipeline-flag-on', '/pipelines/<id> renders the board with crm_pipeline on'],
  ['@p06-pipeline-shell', 'the CRM shell, the Deals entry linking /pipelines and current, no link a 404'],
  ['@p06-pipeline-index', '/pipelines lists the pipelines by name in served order, each linking its board; an empty state'],
  ['@p06-pipeline-board', 'every open stage then won, by name, never lost; exact counts; cards in served order; axe-clean'],
  ['@p06-pipeline-totals', 'exact per-currency totals and weighted totals as served, never summed across currencies'],
  ['@p06-pipeline-money', 'every amount exact in its currency’s own Intl format, past 2^53'],
  ['@p06-pipeline-paging', 'a column pages on its own cursor and stageId with the same filters; its count stays the server’s'],
  ['@p06-pipeline-won', 'won draws the echoed closedSince; a year’s window reaches older wins; lost is never on the board'],
  ['@p06-pipeline-filters', 'q, owner, close window and currency on board and list alike; no filter on a withheld field'],
  ['@p06-pipeline-list', 'listDeals rows in served order, lost included by stage name, no count, no totals'],
  ['@p06-pipeline-sort', 'only the contract’s sort keys; amount, close date, owner and stage do not sort; a new sort drops the cursor'],
  ['@p06-pipeline-list-paging', 'keyset "more" with the cursor echoed for the same sort and filters, out of the URL'],
  ['@p06-pipeline-drag', 'a drag sends exactly { version, toStageId }; a drop on its own column sends nothing; counts re-read'],
  ['@p06-pipeline-move-sheet', 'the move sheet offers exactly the allow-list, lost included, by pointer and keyboard'],
  ['@p06-pipeline-requirements', 'the prompt: met requirements shown met, the rest filled and sent in the same move; the picker’s programme'],
  ['@p06-pipeline-blocked', 'a move off the allow-list is said and never sent; 409 transition_not_allowed translated, never retried'],
  ['@p06-pipeline-unmet', '422 names requirements by label, learning a new one by re-reading the pipeline; never retried'],
  ['@p06-pipeline-stale', '409 stale_write re-reads and rebases (D-L102), through two 409s; a prompt-less move not resent'],
  ['@p06-pipeline-not-editable', 'a withheld required field is a lock; 403 field_not_editable names fields; an agent’s 403 translated'],
  ['@p06-pipeline-create', 'create: name and money as a minor-unit string and currency, exact, in the first open stage'],
  ['@p06-pipeline-create-refused', 'a refused create is a translated message and the form keeps what was typed'],
  ['@p06-pipeline-locked', 'withheld amounts, owners and close dates are locks, never zero; null is not a lock; a former owner'],
  ['@p06-pipeline-rotting', 'rotting as served from the stage’s own days, never the design’s 7/14 rule'],
  ['@p06-pipeline-links', 'summaries link only from well-formed uuids; markup is text; no id printed'],
  ['@p06-pipeline-states', 'loading, empty, failed, not found, a malformed id and a failed column kept apart; the list’s too'],
  ['@p06-pipeline-offline', 'offline: every write and drag disabled, nothing queued, sent or stored'],
  ['@p06-pipeline-hidden', 'no US$, FX, territory, amount band, AI, products, quotes, approvals, attachments, WhatsApp, Undo or summary'],
  ['@p06-pipeline-mobile', '360 px: no sideways page scroll, axe-clean, the move sheet works'],
  ['@p06-pipeline-pseudo', 'en-XA renders pseudo text on the board, the sheet, the prompt, the form and the list'],
  ['@p06-pipeline-budget', '/pipelines/[pipelineId] inside its byte budget on the production build'],
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

const INDEX_ROUTE = /^apps\/web\/app\/(?:\([\w-]+\)\/)*pipelines\/page\.tsx$/;
const BOARD_ROUTE = /^apps\/web\/app\/(?:\([\w-]+\)\/)*pipelines\/\[pipelineId\]\/page\.tsx$/;

function routePage(pattern: RegExp): string | undefined {
  return trackedFiles('apps/web/app').find((file) => pattern.test(file));
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Shared shells other suites hold; not part of this slice. */
const SHARED_SHELLS = ['apps/web/components/auth/', 'apps/web/components/crm/', 'apps/web/components/admin/'];

/** The `pipelines` route directory: the index page's, or the board page's parent. */
function routeDirectory(): string | undefined {
  const index = routePage(INDEX_ROUTE);
  if (index !== undefined) return posix.dirname(index);
  const board = routePage(BOARD_ROUTE);
  return board === undefined ? undefined : posix.dirname(posix.dirname(board));
}

/**
 * The slice: every file in the route directory, and everything they import by
 * a relative path, transitively, minus the shared shells.
 */
function sliceSources(): SourceFile[] {
  const directory = routeDirectory();
  if (directory === undefined) {
    return [];
  }
  const sources = new Map(webSources().map((entry) => [entry.file, entry.source]));
  const queue = [...sources.keys()].filter((file) => file.startsWith(`${directory}/`));
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

/** The slice, refused unless both routes exist and it contains the P06/01 screen itself. */
function screenSlice(): SourceFile[] {
  expect(routePage(INDEX_ROUTE), 'there is no apps/web/app/**/pipelines/page.tsx').toBeDefined();
  expect(routePage(BOARD_ROUTE), 'there is no apps/web/app/**/pipelines/[pipelineId]/page.tsx').toBeDefined();
  const slice = sliceSources();
  expect(
    slice.filter(({ source }) => /['"`]P06\/01['"`]/.test(withoutComments(source))).map(({ file }) => file),
    'the /pipelines routes import no P06/01 screen (data-screen="P06/01")',
  ).not.toEqual([]);
  return slice;
}

/** apps/web/lib modules that call the pipelines or deals API. */
function pipelineClients(): SourceFile[] {
  return webSources().filter(
    ({ file, source }) => file.startsWith('apps/web/lib/') && /\/api\/v1\/(pipelines|deals)\b/.test(withoutComments(source)),
  );
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8')) as Record<string, string>;
}

const BUDGET_LITERAL = /const PIPELINE_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(BUDGET_LITERAL, 'const PIPELINE_BUDGET_BYTES = <budget>;');
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
 * rule sees only a string that IS a hex value). The design's rotting tints
 * and drop-target colours are tokens (`--k-warning-soft`, `--k-danger-soft`,
 * `--k-primary-soft`); a `color-mix(...)` in apps/web is a literal too.
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
 * Money handled as something it is not: a currency symbol written into the
 * source (the format is Intl's, R5), or `amountMinor` / `weightedAmountMinor`
 * passed through `Number`, `parseFloat` or `parseInt` (exact only to 2^53;
 * these amounts reach 18 and totals 24 digits). A heuristic: the e2e money
 * journeys are the real check.
 */
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

/** The body of an exported async function in lib/feature-flags.ts. */
function flagFunctionBody(name: string): string {
  const flagModule = withoutComments(readFileSync(fromRoot('apps/web/lib/feature-flags.ts'), 'utf8'));
  const match = new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(flagModule);
  return match?.[1] ?? '';
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

// ===========================================================================
// 1. The flag, the routes, the nav, the harness and the client
// ===========================================================================

describe('acceptance: T-0109 — crm_pipeline exists, is off, is not production-ready, and gates /pipelines', () => {
  it('registers crm_pipeline, not production-ready, and it evaluates OFF by default', async () => {
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

  it('has both route files, each calling notFound() on crm_pipeline, read on the server only', () => {
    const readers = readersOf(FLAG).filter((name) => name !== 'crmLiveNav');
    for (const [pattern, what] of [
      [INDEX_ROUTE, 'apps/web/app/**/pipelines/page.tsx'],
      [BOARD_ROUTE, 'apps/web/app/**/pipelines/[pipelineId]/page.tsx'],
    ] as const) {
      const page = routePage(pattern);
      expect(page, `there is no ${what}`).toBeDefined();
      const source = withoutComments(readFileSync(fromRoot(page ?? 'missing'), 'utf8'));
      expect(source, `${page} does not call notFound()`).toMatch(/\bnotFound\s*\(/);
      expect(source, `${page} imports nothing from lib/feature-flags`).toMatch(/from ['"][./]*lib\/feature-flags['"]/);
      const gated = readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source)) || new RegExp(`['"]${FLAG}['"]`).test(source);
      expect(gated, `${page} is not gated on ${FLAG} (readers found: ${readers.join(', ') || 'none'})`).toBe(true);
    }
    const clientEvaluators = webSources().filter(({ source: code }) => /^\s*['"]use client['"]/m.test(code) && code.includes(FLAG));
    expect(clientEvaluators.map(({ file }) => file), 'a client module names crm_pipeline — flags are read on the server only').toEqual([]);
  });

  it('links the Deals nav entry to /pipelines only where crm_pipeline is on (R2)', () => {
    const nav = withoutComments(readFileSync(fromRoot('apps/web/components/crm/crm-nav.ts'), 'utf8'));
    expect(nav, 'the Deals nav entry does not link /pipelines').toMatch(/id:\s*['"]deals['"][^}]*href:\s*['"]\/pipelines['"]/);
    const live = flagFunctionBody('crmLiveNav');
    expect(live, 'crmLiveNav() is gone from lib/feature-flags.ts').not.toBe('');
    expect(live, 'crmLiveNav() never lists the deals entry').toMatch(/['"]deals['"]/);
    const readers = readersOf(FLAG).filter((name) => name !== 'crmLiveNav');
    expect(
      readers.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(live)) || new RegExp(`['"]${FLAG}['"]`).test(live),
      'crmLiveNav() does not read crm_pipeline: the Deals entry would link with the flag off',
    ).toBe(true);
  });

  it('serves the journeys from the records process with crm_pipeline on, publishes webPipelineUrl, and leaves the default server flagless (R3)', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    const processes = [...runner.matchAll(/KASUWA_FEATURE_FLAGS_ON:\s*['"`]([^'"`]*)['"`]/g)].map((match) => (match[1] ?? '').split(/[,\s]+/));
    expect(
      processes.some((flags) => flags.includes(FLAG) && RECORDS_PROCESS_FLAGS.every((flag) => flags.includes(flag))),
      `no web process in run-e2e.mjs carries ${FLAG} beside ${RECORDS_PROCESS_FLAGS.join(', ')}`,
    ).toBe(true);
    expect(runner, 'run-e2e.mjs does not publish webPipelineUrl in the stack file').toContain('webPipelineUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*''/);
  });

  it('calls the pipelines and deals API same-origin, Zod-parsed, with no scope argument and no test support', () => {
    const clients = pipelineClients();
    const calling = (path: RegExp) => clients.filter(({ source }) => path.test(withoutComments(source))).map(({ file }) => file);
    expect(calling(/\/api\/v1\/pipelines\b/), 'no apps/web/lib module calls /api/v1/pipelines').not.toEqual([]);
    expect(calling(/\/api\/v1\/deals\b/), 'no apps/web/lib module calls /api/v1/deals (the move)').not.toEqual([]);
    for (const { file, source } of clients) {
      const code = withoutComments(source);
      expect(code, `${file} names an absolute API origin`).not.toMatch(/https?:\/\/[^'"`]*\/api\/v1/);
      expect(code, `${file} does not parse with Zod`).toMatch(/from ['"]zod['"]/);
      // `owner` IS a contract filter here (me, unassigned, ids); a programme in a query or a header is scope from the client.
      expect(code, `${file} builds a scope argument`).not.toMatch(/programmeIds|(set|append)\(\s*['"`]programme|['"`]x-[\w-]*(programme|tenant)/i);
    }
    for (const { file: name, source } of webSources()) {
      expect(withoutComments(source), `${name} imports test support`).not.toMatch(
        /from ['"][^'"]*(tests\/e2e|pipeline-mock|records-mock|@kasuwa\/testing)[^'"]*['"]/,
      );
    }
  });

  it('writes no currency symbol and never makes a JS number of an amount, in the slice or the client (R5)', () => {
    const found = [...screenSlice(), ...pipelineClients()].flatMap(({ file, source }) => moneyHazards(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'money is formatted by hand or parsed into a JS number — use Intl with the string, or BigInt').toEqual([]);
  });
});

// ===========================================================================
// 2. i18n — the lint rule, every catalogue, D-P1
// ===========================================================================

describe('acceptance: T-0109 — every string through i18n, in every catalogue, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the board’s route file', () => {
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(
      /files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/,
    );
    // A rule only ever seen passing proves nothing: plant a literal at the route's own path.
    const page = routePage(BOARD_ROUTE);
    expect(page, 'there is no apps/web/app/**/pipelines/[pipelineId]/page.tsx').toBeDefined();
    const planted = eslint(
      ['--stdin', '--stdin-filename', page ?? 'apps/web/app/pipelines/[pipelineId]/page.tsx', '--format', 'json'],
      'export default function Planted() {\n  return <p>Move to Negotiation</p>;\n}\n',
    );
    expect(planted.output, `a literal JSX string at ${page} is not rejected:\n${planted.output.slice(-2000)}`).toContain('i18next/no-literal-string');
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean and types no user-facing attribute', () => {
    const slice = screenSlice();
    const run = eslint(['--max-warnings', '0', ...slice.map(({ file }) => file)]);
    expect(run.status, `eslint fails on the pipeline slice:\n${run.output.slice(-4000)}`).toBe(0);
    // jsx-text-only cannot see attributes; an English aria-label is still English.
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }
  });

  it('puts every message the slice names, and a label for each rotting state, requirement field, former owner and field_not_editable, in every design-menu catalogue', async () => {
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
    expect(named.size, 'the pipeline slice names almost no message id').toBeGreaterThan(20);

    const find = (what: string, key: string | undefined): string => {
      expect(key, `en.json has no label for ${what}`).toBeDefined();
      return key ?? `<missing ${what}>`;
    };
    const rotting = enumAt('DealRotting', 'enum');
    expect(rotting, 'the contract’s rotting states changed').toEqual(['fresh', 'stale', 'rotting']);
    const rottingKeys = ['stale', 'rotting'].map((state) =>
      find(`the ${state} state (an id about deals or pipelines ending ".rotting.${state}")`, dealKey(en, [`.rotting.${state}`])),
    );
    const fields = enumAt('DealRequirementField', 'enum');
    expect(fields.length, 'the contract lists no requirement fields').toBeGreaterThan(0);
    const fieldKeys = fields.map((name) => find(`the ${name} field (an id about deals or pipelines ending ".field.${name}")`, dealKey(en, [`.field.${name}`])));
    const refusalKey = find('field_not_editable (an id about deals or pipelines ending ".field_not_editable" or ".fieldNotEditable")', dealKey(en, ['.field_not_editable', '.fieldNotEditable']));
    const formerKey = find(
      'a former owner (an id ending ".owner.former", ".formerOwner" or ".former_owner")',
      Object.keys(en).find((id) => /\.owner\.former$|\.formerOwner$|\.former_owner$/.test(id)),
    );

    const missing: string[] = [];
    for (const locale of i18n.DESIGN_MENU_LOCALES) {
      const messages = catalogue(locale);
      for (const key of [...named, ...rottingKeys, ...fieldKeys, refusalKey, formerKey]) {
        if (typeof messages[key] !== 'string' || messages[key].trim() === '') {
          missing.push(`${locale}: ${key}`);
        }
      }
    }
    expect(missing, 'message ids the pipeline screen uses that a catalogue lacks').toEqual([]);
  });

  it('localises every error the P06 operations can answer with', () => {
    const en = catalogue('en');
    const codes = new Set(OPERATIONS.flatMap(([path, method]) => errorCodes(path, method)));
    // Vacuity guard: the move's own conflicts must be among them.
    expect([...codes], 'the P06 operations declare no error codes').toEqual(
      expect.arrayContaining(['not_found', 'not_permitted', 'stale_write', 'transition_not_allowed', 'requirements_unmet', 'validation_failed']),
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

describe('acceptance: T-0109 — no colour literal and no device storage in the slice', () => {
  it('the colour and money detectors catch what the lint rule misses', () => {
    // Planted first: a detector only ever seen finding nothing proves nothing.
    // Passes before the work starts, by design.
    for (const planted of [
      'className="text-[#c00] p-2"',
      "style={{ color: 'red' }}",
      'className="bg-amber-100"',
      "const tint = 'color-mix(in oklch, var(--k-danger) 18%, var(--k-surface))';",
      'className="border-white"',
    ]) {
      expect(colourLiterals(planted), `the colour detector missed ${planted}`).not.toEqual([]);
    }
    expect(colourLiterals('className="bg-surface text-text-2 border-border-strong text-danger-text bg-warning-soft"')).toEqual([]);
    for (const planted of [
      "const label = '₦' + amount;",
      'const cedi = `GH₵${value}`;',
      "const shilling = 'KSh ' + value;",
      'const major = Number(deal.amount.amountMinor) / 100;',
      'const total = parseFloat(stage.totals[0]?.weightedAmountMinor ?? "0");',
    ]) {
      expect(moneyHazards(planted), `the money detector missed ${planted}`).not.toEqual([]);
    }
    expect(
      moneyHazards("new Intl.NumberFormat(locale, { style: 'currency', currency }).format(`${whole}.${fraction}`); BigInt(deal.amount.amountMinor);"),
    ).toEqual([]);
  });

  it('the slice reaches the screen through its imports, and stops at the shared shells', () => {
    const slice = screenSlice();
    const files = slice.map(({ file }) => file);
    expect(files).toContain(routePage(BOARD_ROUTE) ?? '<no board page>');
    expect(files).toContain(routePage(INDEX_ROUTE) ?? '<no index page>');
    expect(files.filter((file) => SHARED_SHELLS.some((shell) => file.startsWith(shell)))).toEqual([]);
    expect(files.length, 'the slice is the route files alone: nothing they import was followed').toBeGreaterThan(2);
  });

  it('writes no colour literal anywhere in the slice', () => {
    const found = screenSlice().flatMap(({ file, source }) => colourLiterals(source).map((hit) => `${file}: ${hit}`));
    expect(found, 'colour literals in the pipeline slice — use a token from @kasuwa/ui').toEqual([]);
  });

  it('touches no device-storage API (D-L64, D-P21)', () => {
    const storage = /\b(localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|navigator\.storage|document\.cookie)\b/;
    const found = [...screenSlice(), ...pipelineClients()].filter(({ source }) => storage.test(withoutComments(source))).map(({ file }) => file);
    expect(found, 'the pipeline slice uses a device-storage API: the board lives in memory only').toEqual([]);
  });
});

// ===========================================================================
// 4. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0109 — the journeys and the mock are the ones this suite was written with', () => {
  it('pins p06-pipeline.spec.ts and pipeline-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(
        normalisedHash(file),
        `${file} changed. It is part of the T-0109 acceptance contract: ask the lead to re-pin it ` +
          '(only PIPELINE_BUDGET_BYTES may move without that).',
      ).toBe(pinned);
    }
    const mock = readFileSync(fromRoot(MOCK), 'utf8');
    expect(mock, 'the mock no longer reads the records contract').toContain(CONTRACT);
    expect(mock, 'the mock no longer checks its own answers against the contract').toMatch(/answerProblems\(operation, status, body\)/);
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    expect(spec, 'the journeys no longer fix the browser clock').toContain('page.clock.setFixedTime(new Date(NOW))');
    expect(BUDGET_LITERAL.test(spec), 'PIPELINE_BUDGET_BYTES is not where it was').toBe(true);
  });
});

// ===========================================================================
// 5. The tag is this screen's alone (D-L84)
// ===========================================================================

describe('acceptance: T-0109 — @p06-pipeline selects these journeys and nothing else', () => {
  it('no other spec carries a tag @p06-pipeline matches, ours matches no other parent tag, and the spec carries only ours', () => {
    // Passes before the work starts: it guards later screens (T-0110) against
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
// 6. The browser — one run of @p06-pipeline
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0109 e2e run did not start', outcomes: undefined, startedAt: 0 };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

function outcomes(): E2eOutcome[] {
  expect(e2eRun.outcomes, `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-6000)}`).toBeDefined();
  return e2eRun.outcomes ?? [];
}

describe('acceptance: T-0109 — the pipeline board in a browser', () => {
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

  it('runs every @p06-pipeline journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(journeys.length, 'the run reported fewer @p06-pipeline tests than there are behaviours').toBeGreaterThanOrEqual(REQUIRED.length);
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p06-pipeline tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter((outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag));
      expect(proving.length, `no PASSING @p06-pipeline test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('pins /pipelines/[pipelineId] at or under 260,000 bytes and within 5% of what this run measured (R19)', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'PIPELINE_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /pipelines/[pipelineId] budget is above its ceiling').toBeLessThanOrEqual(PIPELINE_BUDGET_CEILING);
    expect(budget).toBeLessThan(PRD_CEILING_BYTES);

    const record = fromRoot(BUDGET_RECORD);
    expect(existsSync(record), 'the budget test wrote no measurement').toBe(true);
    expect(statSync(record).mtimeMs, 'the measurement is older than this run').toBeGreaterThanOrEqual(e2eRun.startedAt);
    const measured = (JSON.parse(readFileSync(record, 'utf8')) as { transferredBytes: number }).transferredBytes;
    expect(measured, 'the measurement is empty').toBeGreaterThan(0);
    expect(budget, `the budget is under the ${measured} bytes measured`).toBeGreaterThanOrEqual(measured);
    expect(budget, `the budget is more than 5% over the ${measured} bytes measured — the lead re-pins PIPELINE_BUDGET_BYTES`).toBeLessThanOrEqual(
      Math.round(measured * BUDGET_HEADROOM),
    );
  });
});
