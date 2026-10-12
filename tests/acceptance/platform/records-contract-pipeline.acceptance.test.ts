import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0105, the records API contract for PIPELINES AND DEALS (P06;
 * D-L88, D-P18, D-P19, D-P20, D-P13, D-L72, D-L80, D-L97, D-L102). Agent 3
 * owns the follow-up APIs (T-0107 the board, T-0108 deals and the gated move)
 * and Agent 11 the screens (T-0109, T-0110). Contract only: no route, no
 * migration, no code. Written by QA for the lead from the invariants (D-L23,
 * D-L25).
 *
 * The artefact under test is `docs/api/records.openapi.yaml`, read as data
 * (parsed YAML, never a regex over the raw text, so a keyword in a YAML
 * comment satisfies nothing). The T-0039 suite keeps the whole-file rules
 * (every `$ref` resolves, unique operationIds, one Error schema, every
 * operation documents 401); this suite does not repeat them.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT THIS SUITE PINS
 * ---------------------------------------------------------------------------
 *
 *   listPipelines    GET   /api/v1/pipelines
 *   getPipeline      GET   /api/v1/pipelines/{pipelineId}
 *   getPipelineBoard GET   /api/v1/pipelines/{pipelineId}/board
 *   listDeals        GET   /api/v1/pipelines/{pipelineId}/deals
 *   createDeal       POST  /api/v1/pipelines/{pipelineId}/deals
 *   getDeal          GET   /api/v1/deals/{dealId}
 *   updateDeal       PATCH /api/v1/deals/{dealId}
 *   moveDeal         POST  /api/v1/deals/{dealId}/move
 *
 *   All eight `x-kasuwa-implemented: false`, P06 frames only, `Cache-Control:
 *   no-store` on every answer, the one 404 body (a non-uuid id included),
 *   `x-kasuwa-error-order` and `x-kasuwa-rights` on each, and no other
 *   operation on a pipeline or deal path.
 *
 *   MONEY: `amount` is `DealMoney { amountMinor: string, currency }`, closed,
 *   one currency per deal, never converted. PROBABILITY: the stage's
 *   `probabilityBp`, 0..10000. WEIGHTED: half-even per deal, then summed; the
 *   board example is built so that rounding once at the end, or half-up,
 *   gives a different answer, and the suite checks the right one.
 *
 *   STAGES: open, won or lost; exactly one won and one lost; positions open,
 *   won, lost. TRANSITIONS: the seed rule, checked pair by pair on the
 *   example. REQUIREMENTS: `field` (standard deal fields only) or `check`.
 *
 *   ERRORS: 404 before 403 before 400 before 409/422, with one ruled
 *   exception (below). `409 transition_not_allowed`, `422 requirements_unmet`
 *   naming requirement ids only, `403 field_not_editable`.
 *
 *   BOARD (D-P19): exact `count` and per-currency `totals` per column, totals
 *   omitted when `amount` is withheld, `400 field_withheld` on a filter on a
 *   withheld field, per-column paging on id-only cursors, won bounded by
 *   `closedSince` (default 90 days). Lists (listPipelines, listDeals) keep
 *   D-P13: no count of any kind.
 *
 *   HIDDEN (D-L88): no FX or US$, territory, AI risk, product, price book,
 *   quote, approval, attachment, last WhatsApp contact, contact role,
 *   competitor, locked KYC check or Loans template, by any name, anywhere in
 *   the eight operations or their schemas.
 *
 * ---------------------------------------------------------------------------
 * RULINGS BEYOND D-L88 (the lead accepts or reverses each; R-numbers are
 * this suite's, not decision ids)
 * ---------------------------------------------------------------------------
 *
 *   R1  Paths. The board, listDeals and createDeal nest under the pipeline,
 *       so neither a body nor a query ever carries `programmeId` or
 *       `pipelineId`. A deal is `/api/v1/deals/{dealId}`; the move is a POST
 *       action on it.
 *   R2  Permissions. `deal.write` (agent, team_lead, programme_manager,
 *       admin; own deals only for the agent), `deal.write_any` (team_lead,
 *       programme_manager, admin), `deal.reassign` (the same three),
 *       `pipeline.write` (admin; not in this contract). `x-kasuwa-rights`
 *       states read/own/any/none per seeded set. `qa_analyst` reads and
 *       never writes, as for contacts; `client_portal` neither reads nor
 *       writes here (L1, D-L115).
 *   R3  Every deal is created in the first open stage; createDeal takes no
 *       `stageId`, and the first open stage never has requirements. An
 *       agent giving a deal to anyone else is `403` with
 *       `owner_not_self`.
 *   R4  A won or lost deal is edited, not only moved, with `deal.write_any`
 *       only (D-L88 says this for leaving won or lost).
 *   R5  Money is the closed `DealMoney` under `amount` (nullable);
 *       `amountMinor` is a non-negative decimal string of at most 18 digits,
 *       no leading zero; an unknown currency is `400 unknown_currency`.
 *       `weightedAmount` is read-only and withheld with `amount`. A deal has
 *       no probability of its own; won is 10000 bp and lost 0.
 *   R6  `field` requirements name standard deal fields only (amount,
 *       expectedCloseDate, nextStep, primaryContactId, accountId); custom
 *       fields wait for custom-field values (D-L60). A move's `fields` and
 *       `checks` may name only the target stage's own requirements (`400
 *       not_a_requirement`). A recorded check stays recorded.
 *   R7  The exception to 403-before-400: a REQUIRED field the mover may not
 *       edit is decided after the body (it depends on `toStageId`). A required
 *       field the mover may not READ refuses the move whatever its value;
 *       otherwise the 403/422 split would say whether a withheld field is
 *       empty. One the mover reads but may not edit refuses only when unmet.
 *   R8  `422` details are `{ path: requirements.<id>, code: requirement_unmet
 *       }`; `transition_not_allowed` and `requirements_unmet` join admin's
 *       shared `Error.code` enum.
 *   R9  The board names stages by id only (names from getPipeline); lost is
 *       not a column; a column pages through the board itself (`stageId` plus
 *       `cursor`); cards are full Deal rows; open columns by `stageEnteredAt`
 *       ascending, won by `closedAt` descending, ties on `id`; 1..50 cards per
 *       column, default 20; totals sorted by currency, `[]` when empty.
 *   R10 Filters: `q` (name), `owner`, `closeFrom`/`closeTo` (calendar dates,
 *       reversed is `400 invalid_window`), `currency`, `closedSince`. No
 *       amount band, account, contact or territory filter. listDeals sorts on
 *       never-withheld keys only and its footer totals come from the board.
 *   R11 A non-uuid id is the same 404 on every new operation (T-0080's form).
 *   R12 `rotting` is computed by the server (fresh, stale, rotting; `null` on
 *       won and lost): stale from half `rottingAfterDays` rounded down,
 *       `rottingAfterDays` 2..365, whole 24-hour periods since
 *       `stageEnteredAt`, no zone.
 *   R13 No pipeline configuration write and no deal deletion in this
 *       contract. The P06/07 template picker waits for the configuration
 *       contract.
 *
 * ---------------------------------------------------------------------------
 * LEAD REVIEW (D-L115). Each of these tightens the contract; none loosens a
 * check above. L1, L2 and L4 each carry a planted-defect self-check.
 * ---------------------------------------------------------------------------
 *
 *   L1  `client_portal: none` on all five reads (and on the three writes, as
 *       before). D-P26 shows portal users actors as role labels and never
 *       free text such as `nextStep`; a deal would send staff names
 *       (`owner.displayName`, `checks[].checkedBy.displayName`). For the
 *       portal, listPipelines is an empty page and every other read the one
 *       404. Restoring portal reads later is additive. This reverses R2's
 *       "client_portal reads" for pipelines and deals.
 *   L2  `closedSince` reaches back at most 366 days: earlier is `400
 *       validation_failed`, `window_too_long` at `closedSince`, never
 *       clamped; a future value is `400 invalid_window`.
 *   L3  When field security withholds `ownerUserId`, `own` acts as `none`:
 *       updateDeal and moveDeal answer the same 403 for every deal, so
 *       ownership cannot be probed.
 *   L4  The currencies are NGN, GHS, KES and ZAR (CLAUDE.md section 1; no
 *       USD, D-L88), named in DealMoney. Any other code is `400
 *       unknown_currency`, in a body and in the `currency` filter alike. If
 *       the code is ever enumerated, the enum is exactly those four.
 *   L5  Totals are summed in Postgres `numeric`, never bigint or a JS number,
 *       and a total is at most 24 digits.
 *   L6  `maxItems` on Deal.checks (600), BoardStage.cards (50) and totals
 *       (4), PipelineBoard.stages (29), DealPage.data and PipelinePage.data
 *       (100), each matching its prose bound.
 *   L7  `x-kasuwa-classification: pii` (the D-L91 marker) on Deal `name` and
 *       `nextStep`.
 *   L8  updateDeal's audit records the before and after owner ids on a
 *       reassignment (D-L71, as for contacts); every other field by name.
 *   L9  `q` matches `%` and `_` literally.
 *   L10 Path ids keep `format: uuid`: R11 pins it, so it stays; the prose
 *       still says a non-uuid is the same 404, byte for byte.
 *
 * ---------------------------------------------------------------------------
 *
 * D-L23: on main the file has none of the eight operations. Every test then
 * fails naming the missing operation or schema rather than crashing at
 * collection: the spec is loaded lazily. Each negative invariant, and each
 * self-check of a helper, first requires the eight operations, so none passes
 * on a file without them.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const SPEC_REL = 'docs/api/records.openapi.yaml';
const SPEC_PATH = resolve(repoRoot, SPEC_REL);

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// Loading and $ref resolution (the T-0039 suite's loader, unchanged in kind)
// ---------------------------------------------------------------------------

function posix(file: string): string {
  return relative(repoRoot, file).split('\\').join('/');
}

const docCache = new Map<string, { doc: unknown; error: string | null }>();

function loadDoc(file: string): { doc: unknown; error: string | null } {
  const cached = docCache.get(file);
  if (cached) return cached;
  let entry: { doc: unknown; error: string | null };
  if (!existsSync(file)) {
    entry = { doc: undefined, error: `${posix(file)} does not exist` };
  } else {
    try {
      entry = { doc: parse(readFileSync(file, 'utf8')) as unknown, error: null };
    } catch (error) {
      entry = {
        doc: undefined,
        error: `${posix(file)} is not valid YAML: ${(error as Error).message}`,
      };
    }
  }
  docCache.set(file, entry);
  return entry;
}

function spec(): Mapping {
  const { doc, error } = loadDoc(SPEC_PATH);
  if (error !== null) throw new Error(`${error} — the records contract is missing.`);
  if (!isMapping(doc)) throw new Error(`${SPEC_REL} does not parse to a mapping`);
  return doc;
}

interface Located {
  node: unknown;
  file: string;
}

function resolveRef(ref: string, fromFile: string): Located | undefined {
  const hash = ref.indexOf('#');
  const filePart = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? '' : ref.slice(hash + 1);
  const file = filePart === '' ? fromFile : resolve(dirname(fromFile), filePart);
  const { doc, error } = loadDoc(file);
  if (error !== null) return undefined;
  let node: unknown = doc;
  if (pointer !== '') {
    if (!pointer.startsWith('/')) return undefined;
    for (const raw of pointer.slice(1).split('/')) {
      const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(node)) {
        node = node[Number(key)];
      } else if (isMapping(node) && key in node) {
        node = node[key];
      } else {
        return undefined;
      }
    }
  }
  return node === undefined ? undefined : { node, file };
}

function deref(located: Located): Located {
  let current = located;
  for (let hops = 0; hops < 32; hops += 1) {
    if (!isMapping(current.node) || typeof current.node.$ref !== 'string') return current;
    const ref = current.node.$ref;
    const next = resolveRef(ref, current.file);
    if (next === undefined) {
      throw new Error(`unresolved $ref ${ref} (from ${posix(current.file)})`);
    }
    current = next;
  }
  throw new Error('$ref chain longer than 32 hops (a cycle?)');
}

function at(node: unknown, file: string = SPEC_PATH): Located {
  return deref({ node, file });
}

function child(parent: Located, key: string): Located | undefined {
  if (!isMapping(parent.node) || parent.node[key] === undefined) return undefined;
  return at(parent.node[key], parent.file);
}

function schemaNamed(name: string): Located {
  const components = isMapping(spec().components) ? (spec().components as Mapping) : {};
  const schemas = isMapping(components.schemas) ? components.schemas : {};
  if (schemas[name] === undefined) throw new Error(`components.schemas.${name} not found`);
  return at({ $ref: `#/components/schemas/${name}` });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

interface Operation {
  id: string;
  method: string;
  path: string;
  op: Mapping;
  params: Mapping[];
}

function operations(): Operation[] {
  const doc = spec();
  const paths = isMapping(doc.paths) ? doc.paths : {};
  const out: Operation[] = [];
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = at(rawItem).node;
    if (!isMapping(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isMapping(op)) continue;
      const own = Array.isArray(op.parameters) ? op.parameters : [];
      const params = [...shared, ...own].map((parameter) => at(parameter).node).filter(isMapping);
      out.push({ id: str(op.operationId), method, path, op, params });
    }
  }
  return out;
}

function operation(id: string): Operation {
  const found = operations().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`operationId ${id} not found in ${SPEC_REL}`);
  return found;
}

interface Expected {
  id: string;
  method: string;
  path: string;
  screens: string[];
  params: string[];
  responses: string[];
  errorOrder: string[];
}

const PIPELINE_PATH = '/api/v1/pipelines/{pipelineId}';
const DEAL_PATH = '/api/v1/deals/{dealId}';
const FILTERS = ['q', 'owner', 'closeFrom', 'closeTo', 'currency', 'closedSince'];

const EXPECTED: Expected[] = [
  {
    id: 'listPipelines',
    method: 'get',
    path: '/api/v1/pipelines',
    screens: ['P06/01', 'P06/01b'],
    params: ['cursor', 'limit'],
    responses: ['200', '400', '401'],
    errorOrder: ['400 validation_failed'],
  },
  {
    id: 'getPipeline',
    method: 'get',
    path: PIPELINE_PATH,
    screens: ['P06/01', 'P06/02', 'P06/03', 'P06/05'],
    params: ['pipelineId'],
    responses: ['200', '400', '401', '404'],
    errorOrder: ['404 not_found'],
  },
  {
    id: 'getPipelineBoard',
    method: 'get',
    path: `${PIPELINE_PATH}/board`,
    screens: ['P06/01', 'P06/04'],
    params: ['pipelineId', ...FILTERS, 'stageId', 'cursor', 'limit'],
    responses: ['200', '400', '401', '404'],
    errorOrder: ['404 not_found', '400 validation_failed'],
  },
  {
    id: 'listDeals',
    method: 'get',
    path: `${PIPELINE_PATH}/deals`,
    screens: ['P06/01b'],
    params: ['pipelineId', ...FILTERS, 'stageId', 'sort', 'cursor', 'limit'],
    responses: ['200', '400', '401', '404'],
    errorOrder: ['404 not_found', '400 validation_failed'],
  },
  {
    id: 'createDeal',
    method: 'post',
    path: `${PIPELINE_PATH}/deals`,
    screens: ['P06/01'],
    params: ['pipelineId'],
    responses: ['201', '400', '401', '403', '404'],
    errorOrder: ['404 not_found', '403 not_permitted', '400 validation_failed'],
  },
  {
    id: 'getDeal',
    method: 'get',
    path: DEAL_PATH,
    screens: ['P06/05', 'P06/06'],
    params: ['dealId'],
    responses: ['200', '400', '401', '404'],
    errorOrder: ['404 not_found'],
  },
  {
    id: 'updateDeal',
    method: 'patch',
    path: DEAL_PATH,
    screens: ['P06/05', 'P06/06'],
    params: ['dealId'],
    responses: ['200', '400', '401', '403', '404', '409'],
    errorOrder: ['404 not_found', '403 not_permitted', '400 validation_failed', '409 stale_write'],
  },
  {
    id: 'moveDeal',
    method: 'post',
    path: `${DEAL_PATH}/move`,
    screens: ['P06/01', 'P06/01b', 'P06/02', 'P06/03', 'P06/04', 'P06/05', 'P06/06'],
    params: ['dealId'],
    responses: ['200', '400', '401', '403', '404', '409', '422'],
    errorOrder: [
      '404 not_found',
      '403 not_permitted',
      '400 validation_failed',
      '403 not_permitted field_not_editable',
      '409 stale_write',
      '409 transition_not_allowed',
      '422 requirements_unmet',
    ],
  },
];

const ALL_IDS = EXPECTED.map((expected) => expected.id);
const READS = ['listPipelines', 'getPipeline', 'getPipelineBoard', 'listDeals', 'getDeal'];
const WRITES = ['createDeal', 'updateDeal', 'moveDeal'];
const PAGED = ['listPipelines', 'getPipelineBoard', 'listDeals'];

/** The eight operations, or a failure naming the first missing: a gate for negative invariants. */
function gate(): Operation[] {
  return ALL_IDS.map((id) => operation(id));
}

function responses(op: Operation): Map<string, Located> {
  const raw = isMapping(op.op.responses) ? op.op.responses : {};
  return new Map(Object.entries(raw).map(([code, value]) => [code, at(value)]));
}

function jsonMedia(holder: Located | undefined): Located | undefined {
  if (!holder) return undefined;
  const content = child(holder, 'content');
  return content ? child(content, 'application/json') : undefined;
}

function jsonSchema(holder: Located | undefined): Located | undefined {
  const media = jsonMedia(holder);
  return media ? child(media, 'schema') : undefined;
}

function requestBody(id: string): Located | undefined {
  const op = operation(id);
  return op.op.requestBody === undefined ? undefined : at(op.op.requestBody);
}

function requestSchema(id: string): Located {
  const schema = jsonSchema(requestBody(id));
  if (!schema) throw new Error(`${id} has no application/json request schema`);
  return schema;
}

function responseSchema(id: string, status: string): Located {
  const schema = jsonSchema(responses(operation(id)).get(status));
  if (!schema) throw new Error(`${id} has no ${status} application/json schema`);
  return schema;
}

/** Every example value on a media object, `example` and `examples` alike, by label. */
function examplesOf(media: Located | undefined): [string, unknown][] {
  if (!media || !isMapping(media.node)) return [];
  const out: [string, unknown][] = [];
  if (media.node.example !== undefined) out.push(['example', media.node.example]);
  const examples = child(media, 'examples');
  if (examples && isMapping(examples.node)) {
    for (const key of Object.keys(examples.node)) {
      const example = child(examples, key);
      if (example && isMapping(example.node)) out.push([key, example.node.value]);
    }
  }
  return out;
}

function exampleBodies(holder: Located | undefined): Mapping[] {
  return examplesOf(jsonMedia(holder))
    .map(([, value]) => value)
    .filter(isMapping);
}

function description(op: Operation): string {
  return str(op.op.description);
}

/** The description with every run of whitespace collapsed, so a phrase may wrap. */
function prose(text: string): string {
  return text.replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

function properties(schema: Located): Map<string, Located> {
  const out = new Map<string, Located>();
  const node = schema.node;
  if (!isMapping(node)) return out;
  for (const part of Array.isArray(node.allOf) ? node.allOf : []) {
    for (const [key, value] of properties(at(part, schema.file))) out.set(key, value);
  }
  const props = child(schema, 'properties');
  if (props && isMapping(props.node)) {
    for (const key of Object.keys(props.node)) {
      const value = child(props, key);
      if (value) out.set(key, value);
    }
  }
  return out;
}

function schemaDescription(name: string): string {
  const node = schemaNamed(name).node;
  return isMapping(node) ? str(node.description) : '';
}

function keysOf(schema: Located): string[] {
  return [...properties(schema).keys()].sort();
}

function required(schema: Located): string[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  const own = Array.isArray(node.required) ? node.required.map(str) : [];
  const inherited = (Array.isArray(node.allOf) ? node.allOf : []).flatMap((part) =>
    required(at(part, schema.file)),
  );
  return [...own, ...inherited];
}

function types(schema: Located): string[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  const out = new Set<string>();
  if (typeof node.type === 'string') out.add(node.type);
  if (Array.isArray(node.type)) node.type.map(str).forEach((type) => out.add(type));
  if (node.nullable === true) out.add('null');
  if (node.const === null || (Array.isArray(node.enum) && node.enum.includes(null)))
    out.add('null');
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const variants = node[key];
    if (Array.isArray(variants)) {
      variants.forEach((variant) => types(at(variant, schema.file)).forEach((t) => out.add(t)));
    }
  }
  if (out.size === 0 && isMapping(node.properties)) out.add('object');
  return [...out];
}

function enumOf(schema: Located): unknown[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  if (node.const !== undefined && node.const !== null) return [node.const];
  if (Array.isArray(node.enum)) return node.enum.filter((value) => value !== null);
  const items = child(schema, 'items');
  if (items) return enumOf(items);
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const variants = node[key];
    if (Array.isArray(variants)) {
      const found = variants.flatMap((variant) => enumOf(at(variant, schema.file)));
      if (found.length > 0) return found;
    }
  }
  return [];
}

function formatOf(schema: Located): string {
  const node = schema.node;
  if (!isMapping(node)) return '';
  if (typeof node.format === 'string') return node.format;
  for (const key of ['oneOf', 'anyOf']) {
    const variants = node[key];
    if (Array.isArray(variants)) {
      for (const variant of variants) {
        const format = formatOf(at(variant, schema.file));
        if (format !== '') return format;
      }
    }
  }
  return '';
}

function isClosed(schema: Located): boolean {
  return isMapping(schema.node) && schema.node.additionalProperties === false;
}

/** The single object branch of a `{...} | null` property (or the property itself). */
function objectBranch(value: Located, where: string): Located {
  const node = value.node;
  const variants = isMapping(node)
    ? [node.oneOf, node.anyOf].find((candidate): candidate is unknown[] => Array.isArray(candidate))
    : undefined;
  if (!variants) return value;
  const objects = variants
    .map((variant) => at(variant, value.file))
    .filter((variant) => types(variant).includes('object'));
  const [only] = objects;
  if (objects.length !== 1 || !only) {
    throw new Error(`${where}: expected exactly one object branch, found ${objects.length}`);
  }
  return only;
}

/** Every key at every depth of a schema, as dotted paths. Cycle-safe. */
function deepKeys(schema: Located, prefix = '', seen = new Set<unknown>()): string[] {
  if (seen.has(schema.node)) return [];
  seen.add(schema.node);
  const out: string[] = [];
  const node = schema.node;
  for (const combinator of ['oneOf', 'anyOf']) {
    const variants = isMapping(node) ? node[combinator] : undefined;
    if (Array.isArray(variants)) {
      for (const variant of variants) out.push(...deepKeys(at(variant, schema.file), prefix, seen));
    }
  }
  for (const [key, value] of properties(schema)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    out.push(path);
    out.push(...deepKeys(value, path, seen));
    const items = child(value, 'items');
    if (items) out.push(...deepKeys(items, `${path}[]`, seen));
  }
  return out;
}

/** Every enum or const value reachable from a schema. Cycle-safe. */
function deepEnums(schema: Located, seen = new Set<unknown>()): string[] {
  if (seen.has(schema.node)) return [];
  seen.add(schema.node);
  const node = schema.node;
  if (!isMapping(node)) return [];
  const out: string[] = [];
  if (Array.isArray(node.enum)) out.push(...node.enum.map(str));
  if (typeof node.const === 'string') out.push(node.const);
  for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
    const variants = node[combinator];
    if (Array.isArray(variants)) {
      for (const variant of variants) out.push(...deepEnums(at(variant, schema.file), seen));
    }
  }
  for (const value of properties(schema).values()) out.push(...deepEnums(value, seen));
  const items = child(schema, 'items');
  if (items) out.push(...deepEnums(items, seen));
  return out;
}

function leafOf(path: string): string {
  return (path.split('.').pop() ?? path).replace(/\[\]$/, '');
}

function param(op: Operation, name: string): Mapping | undefined {
  return op.params.find((candidate) => candidate.name === name);
}

function paramSchema(parameter: Mapping | undefined): Located {
  return at(parameter?.schema ?? {});
}

function cacheControlSchema(response: Located): Located | undefined {
  const headers = child(response, 'headers');
  if (!headers || !isMapping(headers.node)) return undefined;
  const key = Object.keys(headers.node).find((name) => name.toLowerCase() === 'cache-control');
  const header = key ? child(headers, key) : undefined;
  return header ? child(header, 'schema') : undefined;
}

/** Every schema the eight operations reach: request, response and parameter schemas. */
function touchedSchemas(): [string, Located][] {
  const out: [string, Located][] = [];
  for (const op of gate()) {
    const body = jsonSchema(op.op.requestBody === undefined ? undefined : at(op.op.requestBody));
    if (body) out.push([`${op.id} request`, body]);
    for (const [status, response] of responses(op)) {
      const schema = jsonSchema(response);
      if (schema && /^2/.test(status)) out.push([`${op.id} ${status}`, schema]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A JSON-Schema validator: the subset this contract uses, nothing more. It is
// proven to reject broken copies of the examples before it is trusted.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** "Times are UTC, ISO 8601, with a Z." */
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    Number(y) >= 1 &&
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function validate(raw: Located, value: unknown, path: string): string[] {
  const schema = deref(raw);
  const node = schema.node;
  if (!isMapping(node)) return [`${path}: schema is not a mapping`];
  const problems: string[] = [];
  if (Array.isArray(node.allOf)) {
    for (const part of node.allOf) problems.push(...validate(at(part, schema.file), value, path));
  }
  for (const combinator of ['oneOf', 'anyOf'] as const) {
    const variants = node[combinator];
    if (!Array.isArray(variants)) continue;
    const passing = variants.filter(
      (variant) => validate(at(variant, schema.file), value, path).length === 0,
    ).length;
    if (combinator === 'oneOf' ? passing !== 1 : passing < 1) {
      problems.push(`${path}: matches ${passing} ${combinator} branches`);
    }
  }
  const actual = jsonType(value);
  if (node.type !== undefined) {
    const allowed = (Array.isArray(node.type) ? node.type : [node.type]).map(str);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      return [...problems, `${path}: ${actual}, not ${allowed.join('|')}`];
    }
  }
  if ('const' in node && node.const !== value) problems.push(`${path}: not ${String(node.const)}`);
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(node.enum)}`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof node.minLength === 'number' && length < node.minLength)
      problems.push(`${path}: too short`);
    if (typeof node.maxLength === 'number' && length > node.maxLength)
      problems.push(`${path}: too long`);
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern, 'u').test(value)) {
      problems.push(`${path}: does not match ${node.pattern}`);
    }
    if (node.format === 'uuid' && !UUID.test(value)) problems.push(`${path}: not a uuid`);
    if (node.format === 'date-time') {
      if (!UTC_DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
        problems.push(`${path}: not a UTC date-time with a Z`);
      }
    }
    if (node.format === 'date' && !isCalendarDate(value)) {
      problems.push(`${path}: not a calendar date YYYY-MM-DD`);
    }
  }
  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) problems.push(`${path}: < min`);
    if (typeof node.maximum === 'number' && value > node.maximum) problems.push(`${path}: > max`);
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems)
      problems.push(`${path}: too few items`);
    if (typeof node.maxItems === 'number' && value.length > node.maxItems)
      problems.push(`${path}: too many items`);
    if (node.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) problems.push(`${path}: items are not unique`);
    }
    const items = child(schema, 'items');
    if (items)
      value.forEach((item, index) => problems.push(...validate(items, item, `${path}[${index}]`)));
  }
  if (isMapping(value)) {
    const props = isMapping(node.properties) ? node.properties : {};
    if (typeof node.minProperties === 'number' && Object.keys(value).length < node.minProperties)
      problems.push(`${path}: fewer than ${node.minProperties} properties`);
    for (const key of Array.isArray(node.required) ? node.required.map(str) : []) {
      if (!(key in value)) problems.push(`${path}: ${key} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (props[key] !== undefined) {
        problems.push(...validate(at(props[key], schema.file), item, `${path}.${key}`));
      } else if (node.additionalProperties === false) {
        problems.push(`${path}: ${key} is not a property of this closed object`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Example fixtures read from the contract
// ---------------------------------------------------------------------------

function namedExample(id: string, status: string, label: string): Mapping {
  const found = examplesOf(jsonMedia(responses(operation(id)).get(status))).find(
    ([name]) => name === label,
  );
  if (!found || !isMapping(found[1])) throw new Error(`${id} ${status} has no example ${label}`);
  return found[1];
}

function okExample(id: string, status = '200'): Mapping {
  const [first] = examplesOf(jsonMedia(responses(operation(id)).get(status)));
  if (!first || !isMapping(first[1])) throw new Error(`${id} ${status} has no example`);
  return first[1];
}

function list(value: unknown): Mapping[] {
  return Array.isArray(value) ? value.filter(isMapping) : [];
}

function pipelineExample(): Mapping {
  return okExample('getPipeline');
}

function stagesOf(pipeline: Mapping): Mapping[] {
  return list(pipeline.stages);
}

function stageById(pipeline: Mapping): Map<string, Mapping> {
  return new Map(stagesOf(pipeline).map((stage) => [str(stage.id), stage]));
}

/** Every Deal-shaped example on the eight operations, labelled. */
function dealExamples(): [string, Mapping][] {
  const out: [string, Mapping][] = [];
  for (const [label, board] of examplesOf(
    jsonMedia(responses(operation('getPipelineBoard')).get('200')),
  )) {
    if (!isMapping(board)) continue;
    for (const column of list(board.stages)) {
      for (const card of list(column.cards)) out.push([`board ${label} ${str(card.id)}`, card]);
    }
  }
  for (const row of list(okExample('listDeals').data)) out.push([`listDeals ${str(row.id)}`, row]);
  out.push(['createDeal 201', okExample('createDeal', '201')]);
  out.push(['getDeal 200', okExample('getDeal')]);
  out.push(['updateDeal 200', okExample('updateDeal')]);
  out.push(['moveDeal 200', okExample('moveDeal')]);
  return out;
}

/** The weighted amount of one deal: amountMinor x bp / 10000, rounded half to even (D-L88). */
function halfEven(amountMinor: bigint, bp: bigint): bigint {
  const product = amountMinor * bp;
  const quotient = product / 10000n;
  const twice = (product % 10000n) * 2n;
  if (twice > 10000n) return quotient + 1n;
  if (twice < 10000n) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/** The wrong rule, used to prove the examples tell the two apart: half rounds up. */
function halfUp(amountMinor: bigint, bp: bigint): bigint {
  return (amountMinor * bp * 2n + 10000n) / 20000n;
}

function money(value: unknown): { minor: bigint; currency: string } | null {
  if (!isMapping(value)) return null;
  return { minor: BigInt(str(value.amountMinor)), currency: str(value.currency) };
}

/** Per-currency sums of a column's cards, rounded with `round` per deal. */
function columnSums(
  cards: Mapping[],
  bp: bigint,
  round: (amount: bigint, bp: bigint) => bigint,
): Map<string, { amount: bigint; weighted: bigint }> {
  const out = new Map<string, { amount: bigint; weighted: bigint }>();
  for (const card of cards) {
    const amount = money(card.amount);
    if (!amount) continue;
    const sum = out.get(amount.currency) ?? { amount: 0n, weighted: 0n };
    sum.amount += amount.minor;
    sum.weighted += round(amount.minor, bp);
    out.set(amount.currency, sum);
  }
  return out;
}

function totalsOf(column: Mapping): Map<string, { amount: bigint; weighted: bigint }> {
  return new Map(
    list(column.totals).map((total) => [
      str(total.currency),
      { amount: BigInt(str(total.amountMinor)), weighted: BigInt(str(total.weightedAmountMinor)) },
    ]),
  );
}

function sameSums(
  a: Map<string, { amount: bigint; weighted: bigint }>,
  b: Map<string, { amount: bigint; weighted: bigint }>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [currency, sum] of a) {
    const other = b.get(currency);
    if (!other || other.amount !== sum.amount || other.weighted !== sum.weighted) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The hidden list (D-L88), as words. A camelCase or snake_case name is split
// into words, so `aiRisk`, `last_whatsapp_at` and `contactRoles` are caught
// and `amount` or `stageId` are not.
// ---------------------------------------------------------------------------

const HIDDEN_WORDS = new Set([
  'usd',
  'fx',
  'exchange',
  'conversion',
  'converted',
  'territory',
  'territories',
  'risk',
  'ai',
  'score',
  'product',
  'products',
  'pricebook',
  'price',
  'quote',
  'quotes',
  'approval',
  'approvals',
  'approver',
  'approve',
  'attachment',
  'attachments',
  'file',
  'files',
  'upload',
  'whatsapp',
  'role',
  'roles',
  'competitor',
  'competitors',
  'kyc',
  'locked',
  'nin',
  'bvn',
  'loan',
  'loans',
  'template',
  'templates',
  'disbursed',
  'disbursement',
]);

/** Words that must not appear even in example text (labels and names are user content). */
const HIDDEN_IN_TEXT = new Set(['usd', 'fx', 'kyc', 'nin', 'bvn', 'loan', 'loans', 'disbursed']);

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9$]+/)
    .filter((word) => word !== '');
}

function hiddenWordsIn(name: string, set: Set<string> = HIDDEN_WORDS): string[] {
  const found = words(name).filter((word) => set.has(word));
  if (/us\$|≈/i.test(name)) found.push('US$');
  return found;
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (isMapping(value)) return Object.values(value).flatMap(stringsIn);
  return [];
}

const SETS = ['admin', 'programme_manager', 'team_lead', 'agent', 'qa_analyst', 'client_portal'];
/** L1 (D-L115): every staff set reads; the portal reads no pipeline and no deal. */
const READ_RIGHTS: Record<string, string> = {
  ...Object.fromEntries(SETS.map((set) => [set, 'read'])),
  client_portal: 'none',
};
const WRITE_RIGHTS: Record<string, string> = {
  admin: 'any',
  programme_manager: 'any',
  team_lead: 'any',
  agent: 'own',
  qa_analyst: 'none',
  client_portal: 'none',
};

/** What is wrong with one operation's `x-kasuwa-rights`; empty when it is right. */
function rightsProblems(id: string, rights: unknown): string[] {
  if (!isMapping(rights)) return [`${id}: x-kasuwa-rights missing`];
  const want = READS.includes(id) ? READ_RIGHTS : WRITE_RIGHTS;
  const problems: string[] = [];
  for (const set of SETS) {
    if (rights[set] !== want[set])
      problems.push(`${id}: ${set} is ${String(rights[set])}, not ${String(want[set])}`);
  }
  for (const key of Object.keys(rights)) {
    if (!SETS.includes(key)) problems.push(`${id}: unknown set ${key}`);
  }
  if (rights.client_portal !== 'none') problems.push(`${id}: the portal is let in (D-L115)`);
  return problems;
}

/** L2: what the closedSince parameter's prose fails to say; empty when it says it all. */
function closedSinceProblems(text: string): string[] {
  const problems: string[] = [];
  const t = prose(text);
  if (!/at most 366 days before the request/.test(t)) problems.push('no 366-day bound');
  if (!/`details\[\]\.code: window_too_long` at `closedSince`, never clamped/.test(t))
    problems.push('earlier is not window_too_long at closedSince, never clamped');
  if (
    !/A value after the request is `400 validation_failed` with `details\[\]\.code: invalid_window` at `closedSince`/.test(
      t,
    )
  )
    problems.push('a future value is not invalid_window');
  if (/clamped to|is clamped|clamps/i.test(t)) problems.push('the bound clamps');
  return problems;
}

const CURRENCIES = ['GHS', 'KES', 'NGN', 'ZAR'];

/** L4: what DealMoney and the currency filter fail to say; empty when both say it. */
function currencyProblems(moneyText: string, filterText: string): string[] {
  const problems: string[] = [];
  const money = prose(moneyText);
  const filter = prose(filterText);
  if (
    !/\*\*The currencies are NGN, GHS, KES and ZAR\*\* \(D-L88, D-L115\); there is no USD\./.test(
      money,
    )
  )
    problems.push('DealMoney does not name exactly NGN, GHS, KES and ZAR');
  if (
    !/Any other code, well-formed or not, is `400 validation_failed` with `details\[\]\.code: unknown_currency` at the code's path, in a body \(`amount.currency`, `fields.amount.currency`\) and in the `currency` filter alike/.test(
      money,
    )
  )
    problems.push('DealMoney does not make any other code unknown_currency, body and filter');
  if (!/NGN, GHS, KES or ZAR \(see DealMoney\)/.test(filter))
    problems.push('the filter does not name the four');
  if (
    !/Any other code, USD included, is `400 validation_failed` with `details\[\]\.code: unknown_currency` at `currency`, exactly as in a body/.test(
      filter,
    )
  )
    problems.push('the filter does not make any other code unknown_currency');
  return problems;
}

const NOT_FOUND_BODY = {
  statusCode: 404,
  error: 'Not Found',
  code: 'not_found',
  message: 'Not found',
};

const P06_FRAME = /^P06\/0[1-7]b?$/;
const OFFSET_PAGING =
  /^(offset|skip|page|pageNumber|pageNo|pageIndex|start|total|includeTotal|count)$/i;
const SCOPE_NAME = /programme|tenant|scope|business[-_]?unit/i;
const WITHHOLDABLE = [
  'amount',
  'expectedCloseDate',
  'ownerUserId',
  'primaryContactId',
  'accountId',
  'nextStep',
];
const NEVER_WITHHELD = [
  'id',
  'programmeId',
  'pipelineId',
  'stageId',
  'version',
  'name',
  'stageEnteredAt',
  'closedAt',
  'rotting',
  'checks',
  'createdAt',
  'updatedAt',
  'withheldFields',
];
const DERIVED: [string, string][] = [
  ['weightedAmount', 'amount'],
  ['owner', 'ownerUserId'],
  ['contact', 'primaryContactId'],
  ['account', 'accountId'],
];
const REQUIREMENT_FIELDS = [
  'amount',
  'expectedCloseDate',
  'nextStep',
  'primaryContactId',
  'accountId',
];

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('acceptance: records contract, pipelines and deals (T-0105)', () => {
  describe('the operations', () => {
    for (const expected of EXPECTED) {
      it(`${expected.id} is ${expected.method.toUpperCase()} ${expected.path}, not yet implemented, P06 frames only`, () => {
        const op = operation(expected.id);
        expect(op.method).toBe(expected.method);
        expect(op.path).toBe(expected.path);
        expect(op.op['x-kasuwa-implemented'], 'contract only until T-0107/T-0108').toBe(false);
        const screens = Array.isArray(op.op['x-kasuwa-screens'])
          ? op.op['x-kasuwa-screens'].map(str)
          : [];
        expect(screens).toEqual(expect.arrayContaining(expected.screens));
        expect(screens.filter((screen) => !P06_FRAME.test(screen))).toEqual([]);
        const tags = Array.isArray(op.op.tags) ? op.op.tags.map(str) : [];
        expect(tags.length, 'one tag').toBe(1);
        expect(['pipelines', 'deals']).toContain(tags[0]);
      });
    }

    it('no other operation touches a pipeline or a deal: no configuration write and no deletion (R13)', () => {
      gate();
      const others = operations()
        .filter((op) => /^\/api\/v1\/(pipelines|deals)(\/|$)/.test(op.path))
        .filter((op) => !ALL_IDS.includes(op.id))
        .map((op) => `${op.method.toUpperCase()} ${op.path} (${op.id})`);
      expect(others).toEqual([]);
      expect(
        operations()
          .filter((op) => /pipeline|deal|stage/i.test(op.id) && !ALL_IDS.includes(op.id))
          .map((op) => op.id),
        'a pipeline or deal operation under another path',
      ).toEqual([]);
      expect(
        operations()
          .filter((op) => /\/(stages|transitions|requirements|templates)(\/|$)/.test(op.path))
          .map((op) => op.path),
      ).toEqual([]);
    });

    it('both tags are declared', () => {
      gate();
      const tags = (Array.isArray(spec().tags) ? spec().tags : []) as unknown[];
      const names = tags.filter(isMapping).map((tag) => str(tag.name));
      expect(names).toEqual(expect.arrayContaining(['deals', 'pipelines']));
    });
  });

  describe('parameters and scope', () => {
    for (const expected of EXPECTED) {
      it(`${expected.id} takes exactly ${expected.params.join(', ')}`, () => {
        const op = operation(expected.id);
        expect(op.params.map((parameter) => str(parameter.name)).sort()).toEqual(
          [...expected.params].sort(),
        );
        for (const parameter of op.params) {
          const name = str(parameter.name);
          const where = /Id$/.test(name) && op.path.includes(`{${name}}`) ? 'path' : 'query';
          expect(parameter.in, `${expected.id} ${name}`).toBe(where);
        }
      });
    }

    it('a pipeline or deal id is a uuid path parameter, and a non-uuid is the same 404 byte for byte (R11)', () => {
      for (const name of ['pipelineId', 'dealId']) {
        const op = operation(name === 'pipelineId' ? 'getPipeline' : 'getDeal');
        const parameter = param(op, name);
        expect(parameter?.required).toBe(true);
        expect(formatOf(paramSchema(parameter))).toBe('uuid');
        expect(prose(str(parameter?.description))).toMatch(
          /a value that is not a uuid is the same `404`, byte for byte/,
        );
      }
    });

    it('no operation takes a programme, tenant or scope argument, a header or a cookie, or opts out of auth (rule 1)', () => {
      const offending: string[] = [];
      for (const op of gate()) {
        for (const parameter of op.params) {
          const name = str(parameter.name);
          if (parameter.in === 'header' || parameter.in === 'cookie')
            offending.push(`${op.id}: ${str(parameter.in)} ${name}`);
          if (SCOPE_NAME.test(name)) offending.push(`${op.id}: ${name}`);
        }
        if (op.op.security !== undefined) offending.push(`${op.id}: overrides security`);
        if (/\/(programmes|tenants)\//.test(op.path)) offending.push(`${op.id}: ${op.path}`);
      }
      expect(offending).toEqual([]);
    });

    it('no request body carries programmeId, pipelineId, tenantId or a stage of its own choosing (R1, R3)', () => {
      const offending: string[] = [];
      for (const id of WRITES) {
        for (const key of keysOf(requestSchema(id))) {
          if (/^(programmeIds?|pipelineId|tenantId|stageId)$/.test(key))
            offending.push(`${id}: ${key}`);
        }
      }
      expect(offending).toEqual([]);
    });

    it('owner takes me, unassigned or a uuid, at most 20, and nothing else', () => {
      const schema = paramSchema(param(operation('getPipelineBoard'), 'owner'));
      const accepted = ['me', 'unassigned', '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01'];
      const refused = ['ME', 'someone', '', '7c1d2e3f', 'me,unassigned', ' me'];
      expect(validate(schema, accepted, 'owner')).toEqual([]);
      expect(
        refused.filter((value) => validate(schema, [value], 'owner').length === 0),
        'owner values the contract lets through',
      ).toEqual([]);
      expect(validate(schema, Array(21).fill('me'), 'owner').length).toBeGreaterThan(0);
    });

    it('closeFrom and closeTo are calendar dates, closedSince a UTC date-time, currency an ISO code', () => {
      const op = operation('getPipelineBoard');
      for (const name of ['closeFrom', 'closeTo']) {
        const schema = paramSchema(param(op, name));
        expect(formatOf(schema), name).toBe('date');
        expect(validate(schema, '2026-10-31', name)).toEqual([]);
        for (const bad of ['2026-02-30', '2026-10-31T00:00:00.000Z', '31/10/2026', '2026-1-3']) {
          expect(validate(schema, bad, name).length, `${name} accepted ${bad}`).toBeGreaterThan(0);
        }
      }
      const since = paramSchema(param(op, 'closedSince'));
      expect(formatOf(since)).toBe('date-time');
      expect(validate(since, '2026-07-14T09:00:00+01:00', 'closedSince').length).toBeGreaterThan(0);
      const currency = paramSchema(param(op, 'currency'));
      expect(validate(currency, ['NGN', 'GHS', 'KES', 'ZAR'], 'currency')).toEqual([]);
      for (const bad of ['ngn', 'NG', 'NGNX', '₦', '']) {
        expect(
          validate(currency, [bad], 'currency').length,
          `currency accepted ${bad}`,
        ).toBeGreaterThan(0);
      }
      const text = prose(str(param(op, 'closeTo')?.description));
      expect(text).toMatch(/invalid_window/);
    });

    it('closedSince reaches back at most 366 days, never clamped, and never into the future (L2)', () => {
      for (const id of ['getPipelineBoard', 'listDeals']) {
        const text = str(param(operation(id), 'closedSince')?.description);
        expect(closedSinceProblems(text), id).toEqual([]);
      }
      expect(prose(description(operation('getPipelineBoard')))).toMatch(
        /It reaches back at most 366 days \(`400 window_too_long`, never clamped\) and never into the future \(`400 invalid_window`\)/,
      );
    });

    it('(self-check, L2) a looser closedSince bound is caught', () => {
      const real = str(param(operation('getPipelineBoard'), 'closedSince')?.description);
      expect(closedSinceProblems(real), 'the real prose').toEqual([]);
      const planted: [string, string][] = [
        ['a longer window', real.replace('366 days', '3660 days')],
        ['a clamp', real.replace(/never\s+clamped/, 'clamped to 366 days')],
        ['no future bound', real.replace(/A\s+value\s+after\s+the\s+request[\s\S]*$/, '')],
        ['no reason code', real.replace('window_too_long', 'validation_failed')],
      ];
      for (const [label, text] of planted) {
        expect(text, `${label}: the plant did not change the prose`).not.toBe(real);
        expect(closedSinceProblems(text).length, `${label} passed`).toBeGreaterThan(0);
      }
    });

    it('q searches the never-withheld name, bounded, and refuses NUL', () => {
      const q = param(operation('listDeals'), 'q');
      const node = paramSchema(q).node;
      expect(isMapping(node) ? [node.minLength, node.maxLength] : []).toEqual([1, 100]);
      const text = prose(str(q?.description));
      expect(text).toMatch(/`name` is never withheld/);
      expect(text).toMatch(/NUL/);
      expect(text, 'L9').toMatch(
        /\*\*`%` and `_` match themselves literally\*\* \(D-L115\), never as wildcards/,
      );
    });

    it('listDeals sorts on a fixed set of never-withheld keys, ties on id (R10)', () => {
      const sort = paramSchema(param(operation('listDeals'), 'sort'));
      const values = enumOf(sort).map(str);
      expect([...values].sort()).toEqual(
        [
          '-createdAt',
          '-name',
          '-stageEnteredAt',
          '-updatedAt',
          'createdAt',
          'name',
          'stageEnteredAt',
          'updatedAt',
        ].sort(),
      );
      const keys = values.map((value) => value.replace(/^-/, ''));
      expect(keys.filter((key) => !NEVER_WITHHELD.includes(key))).toEqual([]);
      expect(isMapping(sort.node) ? sort.node.default : undefined).toBe('-updatedAt');
      const text = prose(description(operation('listDeals')));
      expect(text).toMatch(/Never `amount`, `expectedCloseDate` or the owner/);
      expect(text).toMatch(/ties broken by `id`/);
    });

    it('limits: lists 1..100, board cards per column 1..50 default 20, never clamped', () => {
      for (const id of ['listPipelines', 'listDeals']) {
        const node = paramSchema(param(operation(id), 'limit')).node;
        expect(isMapping(node) ? [node.type, node.minimum, node.maximum] : [], id).toEqual([
          'integer',
          1,
          100,
        ]);
      }
      const board = param(operation('getPipelineBoard'), 'limit');
      const node = paramSchema(board).node;
      expect(isMapping(node) ? [node.type, node.minimum, node.maximum, node.default] : []).toEqual([
        'integer',
        1,
        50,
        20,
      ]);
      expect(prose(str(board?.description))).toMatch(/never clamped/);
    });
  });

  describe('paging: id-only cursors (D-L80), no counts on lists (D-P13)', () => {
    for (const id of PAGED) {
      it(`${id}: an opaque, optional, bounded cursor carrying the last row's id and nothing else`, () => {
        const op = operation(id);
        const cursor = param(op, 'cursor');
        expect(cursor, 'no cursor').toBeDefined();
        expect(cursor?.required, 'cursor is optional').not.toBe(true);
        const text = prose(str(cursor?.description));
        expect(text).toMatch(/\*\*Opaque\.\*\*/);
        expect(text).toMatch(/the id of the last row and nothing else \(D-L80\)/);
        expect(text).toMatch(/CURRENT sort key, inside the caller's scope/);
        expect(text).toMatch(/invalid_cursor/);
        expect(text).toMatch(/one body whatever the reason/);
        expect(text).toMatch(/cannot test whether an id exists/);
        const node = paramSchema(cursor).node;
        expect(isMapping(node) && typeof node.maxLength === 'number' && node.maxLength <= 512).toBe(
          true,
        );
        expect(
          op.params
            .map((parameter) => str(parameter.name))
            .filter((name) => OFFSET_PAGING.test(name)),
        ).toEqual([]);
      });
    }

    it('a board cursor belongs to one column: it needs that stageId, and a lost or foreign stage is refused', () => {
      const op = operation('getPipelineBoard');
      const cursor = prose(str(param(op, 'cursor')?.description));
      expect(cursor).toMatch(/a `cursor` sent without `stageId`/);
      expect(cursor).toMatch(/in that stage of this pipeline/);
      const stage = param(op, 'stageId');
      expect(stage?.required).not.toBe(true);
      expect(formatOf(paramSchema(stage))).toBe('uuid');
      expect(prose(str(stage?.description))).toMatch(
        /a lost stage included, is `400 validation_failed`/,
      );
      expect(prose(str(stage?.description))).toMatch(/unknown_reference/);
    });

    for (const [id, item] of [
      ['listPipelines', 'PipelineSummary'],
      ['listDeals', 'Deal'],
    ] as const) {
      it(`${id}: the 200 is a closed { data, nextCursor } page of ${item} with no count of any kind`, () => {
        const page = responseSchema(id, '200');
        expect(isClosed(page)).toBe(true);
        expect(keysOf(page)).toEqual(['data', 'nextCursor']);
        expect(required(page).sort()).toEqual(['data', 'nextCursor']);
        const next = properties(page).get('nextCursor');
        expect(next ? types(next).sort() : []).toEqual(['null', 'string']);
        const data = properties(page).get('data');
        const rows = data ? child(data, 'items') : undefined;
        expect(rows?.node).toBe(schemaNamed(item).node);
        expect(prose(description(operation(id)))).toMatch(/D-P13/);
      });
    }

    it('every array the board and lists answer is bounded as its prose says (L6)', () => {
      const bounds: [string, string, number][] = [
        ['Deal', 'checks', 600],
        ['BoardStage', 'cards', 50],
        ['BoardStage', 'totals', 4],
        ['PipelineBoard', 'stages', 29],
        ['DealPage', 'data', 100],
        ['PipelinePage', 'data', 100],
      ];
      const problems: string[] = [];
      for (const [schema, key, max] of bounds) {
        const node = properties(schemaNamed(schema)).get(key)?.node;
        const actual = isMapping(node) ? node.maxItems : undefined;
        if (actual !== max)
          problems.push(`${schema}.${key}: maxItems ${String(actual)}, not ${max}`);
      }
      expect(problems).toEqual([]);
      // Each bound is the prose's: the limits, the four currencies, 30 stages less lost,
      // and one check per check requirement of at most 30 stages of 20.
      for (const id of ['listPipelines', 'listDeals']) {
        const limit = paramSchema(param(operation(id), 'limit')).node;
        expect(isMapping(limit) ? limit.maximum : undefined, id).toBe(100);
      }
      const board = paramSchema(param(operation('getPipelineBoard'), 'limit')).node;
      expect(isMapping(board) ? board.maximum : undefined).toBe(50);
      const stages = properties(schemaNamed('Pipeline')).get('stages')?.node;
      const requirements = properties(schemaNamed('PipelineStage')).get('requirements')?.node;
      if (!isMapping(stages) || !isMapping(requirements)) throw new Error('no stage bounds');
      expect(Number(stages.maxItems) - 1, 'board columns: every stage but lost').toBe(29);
      expect(Number(stages.maxItems) * Number(requirements.maxItems), 'Deal.checks').toBe(600);
      expect(CURRENCIES.length, 'one total per currency').toBe(4);
      const cards = properties(schemaNamed('BoardStage')).get('cards') ?? at({});
      const card = okExample('getDeal');
      expect(validate(cards, Array(50).fill(card), 'cards'), '50 cards').toEqual([]);
      expect(validate(cards, Array(51).fill(card), 'cards').length, '51 cards').toBeGreaterThan(0);
    });

    it('listDeals has no totals: its footer totals come from the board (R10)', () => {
      const text = prose(description(operation('listDeals')));
      expect(text).toMatch(/\*\*No totals\*\* \(D-P13 stands for record lists\)/);
      expect(text).toMatch(/board's per-currency totals/);
      expect(text).toMatch(/this list never counts/);
    });
  });

  describe('money and probability (D-L88)', () => {
    it('DealMoney is closed: exactly amountMinor (a string) and currency, both required', () => {
      const moneySchema = schemaNamed('DealMoney');
      expect(isClosed(moneySchema)).toBe(true);
      expect(keysOf(moneySchema)).toEqual(['amountMinor', 'currency']);
      expect(required(moneySchema).sort()).toEqual(['amountMinor', 'currency']);
      for (const value of properties(moneySchema).values())
        expect(types(value)).toEqual(['string']);
    });

    it('amountMinor is a non-negative decimal of at most 18 digits with no leading zero; currency is three capitals', () => {
      const moneySchema = schemaNamed('DealMoney');
      const good = ['0', '1', '1500000015', '999999999999999999'];
      const bad = ['-1', '01', '1.5', '1e9', '', ' 1', '1 ', '1000000000000000000', '１'];
      for (const amountMinor of good) {
        expect(validate(moneySchema, { amountMinor, currency: 'NGN' }, 'm'), amountMinor).toEqual(
          [],
        );
      }
      expect(
        bad.filter(
          (amountMinor) =>
            validate(moneySchema, { amountMinor, currency: 'NGN' }, 'm').length === 0,
        ),
        'amounts the contract lets through',
      ).toEqual([]);
      for (const currency of ['ngn', 'NG', 'NGNX', '₦', 'US$']) {
        expect(
          validate(moneySchema, { amountMinor: '1', currency }, 'm').length,
          `accepted ${currency}`,
        ).toBeGreaterThan(0);
      }
      expect(
        validate(moneySchema, { amountMinor: 1500, currency: 'NGN' }, 'm').length,
      ).toBeGreaterThan(0);
    });

    it('every money-named property on the touched schemas is DealMoney or a *Minor string beside a currency', () => {
      const MONEY_NAME = /amount|revenue|balance|price|cost|value|total|money|minor$/i;
      const problems: string[] = [];
      const seen = new Set<unknown>();
      let found = 0;
      const visit = (where: string, schema: Located): void => {
        if (seen.has(schema.node)) return;
        seen.add(schema.node);
        const props = properties(schema);
        for (const [key, value] of props) {
          const path = `${where}.${key}`;
          if (MONEY_NAME.test(key) && key !== 'totals') {
            found += 1;
            const valueTypes = types(value);
            if (valueTypes.includes('number') || valueTypes.includes('integer'))
              problems.push(`${path} is a number`);
            if (valueTypes.includes('object')) {
              if (objectBranch(value, path).node !== schemaNamed('DealMoney').node)
                problems.push(`${path} is money but not DealMoney`);
            } else if (!/Minor$/.test(key)) {
              problems.push(`${path} is a bare amount`);
            } else if (![...props.keys()].includes('currency')) {
              problems.push(`${path} has no currency beside it`);
            }
          }
          for (const variant of ['oneOf', 'anyOf']) {
            const variants = isMapping(value.node) ? value.node[variant] : undefined;
            if (Array.isArray(variants)) variants.forEach((v) => visit(path, at(v, value.file)));
          }
          visit(path, value);
          const items = child(value, 'items');
          if (items) visit(`${path}[]`, items);
        }
      };
      for (const [where, schema] of touchedSchemas()) visit(where, schema);
      expect(problems).toEqual([]);
      expect(found, 'no money-named property inspected').toBeGreaterThanOrEqual(5);
    });

    it('a deal carries amount and weightedAmount as DealMoney or null, and no probability of its own (R5)', () => {
      const deal = schemaNamed('Deal');
      for (const key of ['amount', 'weightedAmount']) {
        const value = properties(deal).get(key);
        expect(value, key).toBeDefined();
        if (!value) continue;
        expect(types(value).sort()).toEqual(['null', 'object']);
        expect(objectBranch(value, key).node).toBe(schemaNamed('DealMoney').node);
      }
      expect(keysOf(deal).filter((key) => /probab|percent|weight(?!edAmount)/i.test(key))).toEqual(
        [],
      );
      expect(keysOf(requestSchema('createDeal'))).not.toContain('weightedAmount');
      expect(keysOf(requestSchema('updateDeal'))).not.toContain('weightedAmount');
    });

    it('probabilityBp is an integer in basis points, 0..10000, on the stage only', () => {
      const stage = schemaNamed('PipelineStage');
      const bp = properties(stage).get('probabilityBp');
      const node = bp?.node;
      expect(isMapping(node) ? [node.type, node.minimum, node.maximum] : []).toEqual([
        'integer',
        0,
        10000,
      ]);
      expect(prose(description(operation('getPipeline')))).toMatch(
        /in basis points \(`probabilityBp`, 0 to 10000; 2500 is 25%\)/,
      );
      expect(prose(description(operation('getPipeline')))).toMatch(
        /A won stage is always 10000 and a lost stage always 0/,
      );
    });

    it('a StageTotal is closed: currency, amountMinor and weightedAmountMinor, all strings', () => {
      const total = schemaNamed('StageTotal');
      expect(isClosed(total)).toBe(true);
      expect(keysOf(total)).toEqual(['amountMinor', 'currency', 'weightedAmountMinor']);
      expect(required(total).sort()).toEqual(['amountMinor', 'currency', 'weightedAmountMinor']);
      for (const value of properties(total).values()) expect(types(value)).toEqual(['string']);
    });

    it('totals are summed in Postgres numeric, never bigint or a JS number, and are at most 24 digits (L5)', () => {
      const text = prose(schemaDescription('StageTotal'));
      expect(text).toMatch(
        /\*\*Sums are computed in Postgres `numeric`, never `bigint` or a JS number\*\* \(D-L115\)/,
      );
      expect(text).toMatch(/fits the 24 digits allowed here/);
      expect(prose(description(operation('getPipelineBoard')))).toMatch(
        /Sums are computed in Postgres `numeric`, never `bigint` or a JS number/,
      );
      const total = schemaNamed('StageTotal');
      for (const key of ['amountMinor', 'weightedAmountMinor']) {
        const value = properties(total).get(key) ?? at({});
        expect(validate(value, '9'.repeat(24), key), `${key}: 24 digits`).toEqual([]);
        expect(validate(value, `1${'0'.repeat(24)}`, key).length, `${key}: 25`).toBeGreaterThan(0);
      }
    });

    it('the currencies are NGN, GHS, KES and ZAR; any other is unknown_currency, body and filter alike (L4)', () => {
      const filter = param(operation('getPipelineBoard'), 'currency');
      expect(currencyProblems(schemaDescription('DealMoney'), str(filter?.description))).toEqual(
        [],
      );
      expect(param(operation('listDeals'), 'currency')).toBe(filter);
      // If the code is ever enumerated, the enum is exactly the four.
      const codeSchemas: [string, Located, boolean][] = [
        [
          'DealMoney.currency',
          properties(schemaNamed('DealMoney')).get('currency') ?? at({}),
          false,
        ],
        [
          'StageTotal.currency',
          properties(schemaNamed('StageTotal')).get('currency') ?? at({}),
          false,
        ],
        ['currency filter', paramSchema(filter), true],
      ];
      for (const [where, schema, isList] of codeSchemas) {
        const values = enumOf(schema).map(str);
        if (values.length > 0) expect([...values].sort(), where).toEqual(CURRENCIES);
        for (const code of CURRENCIES) {
          expect(validate(schema, isList ? [code] : code, where), `${where} ${code}`).toEqual([]);
        }
      }
    });

    it('(self-check, L4) a currency list with USD, or a filter that drops unknown_currency, is caught', () => {
      const money = schemaDescription('DealMoney');
      const filter = str(param(operation('getPipelineBoard'), 'currency')?.description);
      expect(currencyProblems(money, filter), 'the real prose').toEqual([]);
      const planted: [string, string, string][] = [
        ['USD listed', money.replace(/KES\s+and\s+ZAR/, 'KES, ZAR and USD'), filter],
        ['a currency dropped', money.replace(/GHS,\s+KES/, 'KES'), filter],
        ['the filter ignores a code', money, filter.replace(/unknown_currency/g, 'ignored')],
        [
          'the body converts to NGN',
          money.replace(/Any other code/, 'Any other code is NGN; one'),
          filter,
        ],
      ];
      for (const [label, m, f] of planted) {
        expect(m + f, `${label}: the plant did not change the prose`).not.toBe(money + filter);
        expect(currencyProblems(m, f).length, `${label} passed`).toBeGreaterThan(0);
      }
    });

    it("every example deal's weightedAmount is its amount at the stage's probability, rounded half-even, same currency", () => {
      const stages = stageById(pipelineExample());
      const problems: string[] = [];
      const examples = dealExamples();
      for (const [label, deal] of examples) {
        const stage = stages.get(str(deal.stageId));
        if (!stage) {
          problems.push(`${label}: stage ${str(deal.stageId)} is not in the pipeline example`);
          continue;
        }
        const amount = money(deal.amount);
        const weighted = money(deal.weightedAmount);
        if ('amount' in deal !== 'weightedAmount' in deal)
          problems.push(`${label}: amount and weightedAmount are not withheld together`);
        if (!('amount' in deal)) continue;
        if (amount === null || weighted === null) {
          if (amount !== weighted)
            problems.push(`${label}: one of amount and weightedAmount is null`);
          continue;
        }
        if (weighted.currency !== amount.currency)
          problems.push(`${label}: weighted in another currency`);
        const want = halfEven(amount.minor, BigInt(Number(stage.probabilityBp)));
        if (weighted.minor !== want)
          problems.push(`${label}: weighted ${weighted.minor} is not half-even ${want}`);
      }
      expect(problems).toEqual([]);
      expect(examples.length).toBeGreaterThanOrEqual(12);
    });

    it('the board totals are per-currency sums of half-even per-deal weights, never rounded at the end', () => {
      const pipeline = pipelineExample();
      const stages = stageById(pipeline);
      const board = namedExample('getPipelineBoard', '200', 'board');
      const more = namedExample('getPipelineBoard', '200', 'oneColumn');
      const problems: string[] = [];
      let compared = 0;
      for (const column of list(board.stages)) {
        const stageId = str(column.stageId);
        const bp = BigInt(Number(stages.get(stageId)?.probabilityBp));
        // A column's later pages (the oneColumn example) complete it.
        const extra = list(more.stages).filter((c) => str(c.stageId) === stageId);
        const complete = column.nextCursor === null || extra.some((c) => c.nextCursor === null);
        if (!complete) continue;
        const cards = [...list(column.cards), ...extra.flatMap((c) => list(c.cards))];
        compared += 1;
        if (Number(column.count) !== cards.length)
          problems.push(`${stageId}: count ${String(column.count)} for ${cards.length} cards`);
        if (!sameSums(columnSums(cards, bp, halfEven), totalsOf(column)))
          problems.push(`${stageId}: totals are not the per-deal half-even sums`);
        const currencies = list(column.totals).map((total) => str(total.currency));
        if (JSON.stringify(currencies) !== JSON.stringify([...currencies].sort()))
          problems.push(`${stageId}: totals not sorted by currency`);
        if (new Set(currencies).size !== currencies.length)
          problems.push(`${stageId}: two totals for one currency`);
      }
      expect(problems).toEqual([]);
      expect(compared, 'every board column can be checked').toBe(list(board.stages).length);
    });

    it('(self-check) the board example tells half-even from half-up, and per-deal from once-at-the-end', () => {
      const stages = stageById(pipelineExample());
      const board = namedExample('getPipelineBoard', '200', 'board');
      let halfUpDiffers = false;
      let endRoundingDiffers = false;
      for (const column of list(board.stages)) {
        const bp = BigInt(Number(stages.get(str(column.stageId))?.probabilityBp));
        const cards = list(column.cards);
        if (column.nextCursor !== null) continue;
        if (!sameSums(columnSums(cards, bp, halfUp), totalsOf(column))) halfUpDiffers = true;
        const once = new Map<string, { amount: bigint; weighted: bigint }>();
        for (const [currency, sum] of columnSums(cards, bp, halfEven)) {
          once.set(currency, { amount: sum.amount, weighted: halfEven(sum.amount, bp) });
        }
        if (!sameSums(once, totalsOf(column))) endRoundingDiffers = true;
      }
      expect(halfUpDiffers, 'a half-up server would pass the totals check').toBe(true);
      expect(endRoundingDiffers, 'rounding once at the end would pass the totals check').toBe(true);
      expect(halfEven(25n, 1000n)).toBe(2n);
      expect(halfEven(35n, 1000n)).toBe(4n);
      expect(halfEven(26n, 1000n)).toBe(3n);
    });

    it('one currency per deal, never converted, and no column sums across currencies', () => {
      const board = prose(description(operation('getPipelineBoard')));
      expect(board).toMatch(/never converted and never summed across currencies/);
      expect(board).toMatch(
        /rounded half-even PER DEAL, then summed \(D-L88\), never rounded once at the end/,
      );
      expect(prose(schemaDescription('Deal'))).toMatch(/One currency per deal, never converted/);
      expect(prose(schemaDescription('DealMoney'))).toMatch(/never converted/);
    });
  });

  describe('stages, transitions and requirements (D-L88, D-P20)', () => {
    it('StageKind is exactly open, won, lost', () => {
      expect(enumOf(schemaNamed('StageKind')).map(str)).toEqual(['open', 'won', 'lost']);
    });

    it('PipelineStage and Pipeline are closed with exactly their keys', () => {
      const stage = schemaNamed('PipelineStage');
      expect(isClosed(stage)).toBe(true);
      expect(keysOf(stage)).toEqual(
        [
          'id',
          'kind',
          'name',
          'position',
          'probabilityBp',
          'requirements',
          'rottingAfterDays',
        ].sort(),
      );
      expect(required(stage).sort()).toEqual(keysOf(stage));
      const rot = properties(stage).get('rottingAfterDays');
      const node = rot?.node;
      expect(rot ? types(rot).sort() : []).toEqual(['integer', 'null']);
      expect(isMapping(node) ? [node.minimum, node.maximum] : []).toEqual([2, 365]);
      const pipeline = schemaNamed('Pipeline');
      expect(isClosed(pipeline)).toBe(true);
      expect(keysOf(pipeline)).toEqual(
        [
          'createdAt',
          'id',
          'name',
          'programmeId',
          'stages',
          'transitions',
          'updatedAt',
          'version',
        ].sort(),
      );
      expect(isClosed(schemaNamed('StageTransition'))).toBe(true);
      expect(keysOf(schemaNamed('StageTransition'))).toEqual(['fromStageId', 'toStageId']);
      expect(isClosed(schemaNamed('PipelineSummary'))).toBe(true);
      expect(keysOf(schemaNamed('PipelineSummary'))).toEqual(
        ['createdAt', 'id', 'name', 'programmeId', 'updatedAt', 'version'].sort(),
      );
    });

    it('a requirement is a closed field requirement on a standard deal field, or a closed labelled check (R6)', () => {
      const requirement = schemaNamed('StageRequirement');
      const node = requirement.node;
      const variants = isMapping(node) && Array.isArray(node.oneOf) ? node.oneOf : [];
      expect(variants.length).toBe(2);
      const shapes = variants.map((variant) => at(variant, requirement.file));
      const byKind = new Map(
        shapes.map((shape) => [str(enumOf(properties(shape).get('kind') ?? at({}))[0]), shape]),
      );
      expect([...byKind.keys()].sort()).toEqual(['check', 'field']);
      const field = byKind.get('field');
      const check = byKind.get('check');
      if (!field || !check) return;
      expect([isClosed(field), isClosed(check)]).toEqual([true, true]);
      expect(keysOf(field)).toEqual(['field', 'id', 'kind']);
      expect(keysOf(check)).toEqual(['id', 'kind', 'label']);
      expect(required(field).sort()).toEqual(['field', 'id', 'kind']);
      expect(required(check).sort()).toEqual(['id', 'kind', 'label']);
      expect(enumOf(schemaNamed('DealRequirementField')).map(str)).toEqual(REQUIREMENT_FIELDS);
      const fieldEnum = properties(field).get('field');
      expect(fieldEnum?.node).toBe(schemaNamed('DealRequirementField').node);
      // Every requirement field is a withholdable Deal property: the field_not_editable rule can bite.
      expect(REQUIREMENT_FIELDS.filter((name) => !WITHHOLDABLE.includes(name))).toEqual([]);
    });

    it('the pipeline example: exactly one won and one lost, positions 0..n-1 as open, won, lost, fixed won/lost probabilities', () => {
      const stages = stagesOf(pipelineExample());
      const kinds = stages.map((stage) => str(stage.kind));
      expect(kinds.filter((kind) => kind === 'won').length).toBe(1);
      expect(kinds.filter((kind) => kind === 'lost').length).toBe(1);
      expect(kinds.filter((kind) => kind === 'open').length).toBeGreaterThanOrEqual(1);
      expect(stages.map((stage) => stage.position)).toEqual(stages.map((_, index) => index));
      const order = kinds.map((kind) => (kind === 'open' ? 0 : kind === 'won' ? 1 : 2));
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      for (const stage of stages) {
        if (stage.kind === 'won') expect(stage.probabilityBp).toBe(10000);
        if (stage.kind === 'lost') expect(stage.probabilityBp).toBe(0);
        if (stage.kind === 'open') {
          expect(typeof stage.rottingAfterDays, `${str(stage.name)} rotting`).toBe('number');
        } else {
          expect(stage.rottingAfterDays, `${str(stage.name)} rotting`).toBeNull();
        }
      }
      const [first] = stages;
      expect(first?.kind).toBe('open');
      expect(list(first?.requirements), 'the first open stage has requirements').toEqual([]);
      const ids = stages.flatMap((stage) => list(stage.requirements)).map((r) => str(r.id));
      expect(new Set(ids).size, 'requirement ids repeat').toBe(ids.length);
      expect(ids.length, 'the example has no requirements to check').toBeGreaterThanOrEqual(3);
      expect(stages.some((stage) => list(stage.requirements).some((r) => r.kind === 'field'))).toBe(
        true,
      );
      expect(stages.some((stage) => list(stage.requirements).some((r) => r.kind === 'check'))).toBe(
        true,
      );
    });

    it('the transition example is exactly the seed rule: forward one, back to any open, won from the last open, lost from any open, out of won or lost to any open', () => {
      const pipeline = pipelineExample();
      const stages = stagesOf(pipeline);
      const open = stages.filter((stage) => stage.kind === 'open');
      const won = stages.find((stage) => stage.kind === 'won');
      const lost = stages.find((stage) => stage.kind === 'lost');
      const last = open[open.length - 1];
      if (!won || !lost || !last) throw new Error('the example lacks won, lost or an open stage');
      const want = new Set<string>();
      const pair = (a: Mapping, b: Mapping): string => `${str(a.id)}>${str(b.id)}`;
      open.forEach((stage, index) => {
        const next = open[index + 1];
        if (next) want.add(pair(stage, next));
        open.slice(0, index).forEach((earlier) => want.add(pair(stage, earlier)));
        want.add(pair(stage, lost));
      });
      want.add(pair(last, won));
      for (const closed of [won, lost]) open.forEach((stage) => want.add(pair(closed, stage)));
      const actual = list(pipeline.transitions).map(
        (t) => `${str(t.fromStageId)}>${str(t.toStageId)}`,
      );
      expect(new Set(actual).size, 'a transition is listed twice').toBe(actual.length);
      expect([...actual].sort()).toEqual([...want].sort());
      expect(actual.filter((t) => t.split('>')[0] === t.split('>')[1])).toEqual([]);
    });

    it('getPipeline states the stage, requirement, rotting and transition rules', () => {
      const text = prose(description(operation('getPipeline')));
      expect(text).toMatch(/exactly one won and one lost stage/);
      expect(text).toMatch(/the open stages first, then won, then lost/);
      expect(text).toMatch(/The first open stage never has requirements/);
      expect(text).toMatch(/`rottingAfterDays` \(default 14, 2 to 365\)/);
      expect(text).toMatch(/stale from half that, rounded down/);
      expect(text).toMatch(/alerts wait for the notifications module/);
      expect(text).toMatch(
        /forward one stage, back to any open stage, won only from the last open stage, lost from any open stage/,
      );
      expect(text).toMatch(/`409 transition_not_allowed`/);
      expect(text).toMatch(/No pair moves a stage to itself/);
      expect(text).toMatch(/Approvals and attachments are later/);
    });

    it('rotting is server-computed fresh, stale or rotting, and null exactly on won and lost deals (R12)', () => {
      expect(enumOf(schemaNamed('DealRotting')).map(str)).toEqual(['fresh', 'stale', 'rotting']);
      const rotting = properties(schemaNamed('Deal')).get('rotting');
      expect(rotting ? types(rotting).sort() : []).toEqual(['null', 'string']);
      expect(prose(schemaDescription('DealRotting'))).toMatch(
        /whole 24-hour periods since `stageEnteredAt` \(no zone\): `stale` from half the stage's `rottingAfterDays`, rounded down/,
      );
      const kinds = new Map(
        stagesOf(pipelineExample()).map((stage) => [str(stage.id), str(stage.kind)]),
      );
      const problems: string[] = [];
      for (const [label, deal] of dealExamples()) {
        const kind = kinds.get(str(deal.stageId));
        const closed = kind === 'won' || kind === 'lost';
        if (closed !== (deal.rotting === null))
          problems.push(`${label}: rotting ${String(deal.rotting)} on ${String(kind)}`);
        if (closed !== (deal.closedAt !== null))
          problems.push(`${label}: closedAt ${String(deal.closedAt)} on ${String(kind)}`);
      }
      expect(problems).toEqual([]);
    });
  });

  describe('deals: schemas and field security', () => {
    it('Deal is closed; never-withheld fields are required and the rest optional', () => {
      const deal = schemaNamed('Deal');
      expect(isClosed(deal)).toBe(true);
      expect(required(deal).sort()).toEqual([...NEVER_WITHHELD].sort());
      expect(keysOf(deal)).toEqual(
        [...NEVER_WITHHELD, ...WITHHOLDABLE, ...DERIVED.map(([derived]) => derived)].sort(),
      );
    });

    it('withheldFields names withholdable properties only; a derived one goes with its source', () => {
      const deal = schemaNamed('Deal');
      const withheld = properties(deal).get('withheldFields');
      expect(withheld ? enumOf(withheld).map(str) : []).toEqual(WITHHOLDABLE);
      expect(isMapping(withheld?.node) ? withheld?.node.uniqueItems : undefined).toBe(true);
      const text = prose(schemaDescription('Deal'));
      for (const [derived, source] of DERIVED) {
        expect(text, `${derived} with ${source}`).toMatch(
          new RegExp(`\`${source}\` also( omits)? \`${derived}\``),
        );
      }
      expect(text).toMatch(/Withheld fields are omitted, never nulled/);
      // The examples obey it: a listed field is absent, with its derived partner.
      const problems: string[] = [];
      for (const [label, example] of dealExamples()) {
        for (const name of Array.isArray(example.withheldFields)
          ? example.withheldFields.map(str)
          : []) {
          if (name in example) problems.push(`${label}: ${name} withheld but present`);
          for (const [derived, source] of DERIVED) {
            if (source === name && derived in example)
              problems.push(`${label}: ${derived} present`);
          }
        }
      }
      expect(problems).toEqual([]);
    });

    it('owner, contact, account and a check actor are closed summaries; a former owner is a null name (D-P23)', () => {
      const deal = schemaNamed('Deal');
      const expected: [string, string[], string][] = [
        ['owner', ['displayName', 'id'], 'DealOwner'],
        ['contact', ['displayName', 'id'], 'DealContactSummary'],
        ['account', ['id', 'name'], 'DealAccountSummary'],
      ];
      for (const [key, keys, name] of expected) {
        const value = properties(deal).get(key);
        if (!value) throw new Error(`Deal.${key} missing`);
        expect(types(value), `${key} nullable`).toContain('null');
        const object = objectBranch(value, key);
        expect(object.node, key).toBe(schemaNamed(name).node);
        expect(isClosed(object)).toBe(true);
        expect(keysOf(object)).toEqual(keys);
        expect(required(object).sort()).toEqual(keys);
      }
      const ownerName = properties(schemaNamed('DealOwner')).get('displayName');
      expect(ownerName ? types(ownerName).sort() : []).toEqual(['null', 'string']);
      const check = schemaNamed('DealCheck');
      expect(isClosed(check)).toBe(true);
      expect(keysOf(check)).toEqual(['checkedAt', 'checkedBy', 'requirementId']);
      expect(properties(check).get('checkedBy')?.node).toBe(schemaNamed('DealActor').node);
      expect(keysOf(schemaNamed('DealActor'))).toEqual(['displayName', 'id']);
    });

    it('name and nextStep are x-kasuwa-classification: pii (L7, D-L91)', () => {
      const deal = schemaNamed('Deal');
      for (const key of ['name', 'nextStep']) {
        const node = properties(deal).get(key)?.node;
        expect(isMapping(node) ? node['x-kasuwa-classification'] : undefined, key).toBe('pii');
        expect(prose(str(isMapping(node) ? node.description : '')), key).toMatch(/never logged/);
      }
    });

    it('dates: expectedCloseDate is a calendar date; the times are UTC date-times', () => {
      const deal = schemaNamed('Deal');
      const close = properties(deal).get('expectedCloseDate');
      expect(close ? formatOf(close) : '').toBe('date');
      expect(close ? types(close).sort() : []).toEqual(['null', 'string']);
      for (const key of ['stageEnteredAt', 'closedAt', 'createdAt', 'updatedAt']) {
        const value = properties(deal).get(key);
        expect(value ? formatOf(value) : '', key).toBe('date-time');
      }
    });

    it('createDeal takes exactly the editable fields, requires a name, and takes no stage (R3)', () => {
      const body = requestSchema('createDeal');
      expect(isClosed(body)).toBe(true);
      expect(keysOf(body)).toEqual(
        [
          'accountId',
          'amount',
          'expectedCloseDate',
          'name',
          'nextStep',
          'ownerUserId',
          'primaryContactId',
        ].sort(),
      );
      expect(required(body)).toEqual(['name']);
      const text = prose(description(operation('createDeal')));
      expect(text).toMatch(
        /Every deal starts in the pipeline's first open stage\*\*, which never has requirements, so no create can skip a gate/,
      );
    });

    it('updateDeal is version plus the changed fields only, never the stage (D-L102, D-L88)', () => {
      const body = requestSchema('updateDeal');
      expect(isClosed(body)).toBe(true);
      expect(keysOf(body)).toEqual(
        [
          'accountId',
          'amount',
          'expectedCloseDate',
          'name',
          'nextStep',
          'ownerUserId',
          'primaryContactId',
          'version',
        ].sort(),
      );
      expect(required(body)).toEqual(['version']);
      expect(isMapping(body.node) ? body.node.minProperties : undefined).toBe(2);
      const version = properties(body).get('version')?.node;
      expect(isMapping(version) ? [version.type, version.minimum, version.maximum] : []).toEqual([
        'integer',
        1,
        2147483647,
      ]);
      const text = prose(description(operation('updateDeal')));
      expect(text).toMatch(/ONLY the fields the person changed \(D-L102\)/);
      expect(text).toMatch(/never resend a field they did not touch/);
      expect(text).toMatch(/`stageId` changes only through moveDeal \(D-L88\)/);
      const examples = exampleBodies(requestBody('updateDeal'));
      expect(examples.length).toBeGreaterThanOrEqual(2);
      for (const example of examples) {
        expect(typeof example.version).toBe('number');
        expect(Object.keys(example).length, 'an update that changes nothing').toBeGreaterThan(1);
      }
    });

    it('moveDeal takes version, toStageId, fields and checks; fields are exactly the requirement fields, never null', () => {
      const body = requestSchema('moveDeal');
      expect(isClosed(body)).toBe(true);
      expect(keysOf(body)).toEqual(['checks', 'fields', 'toStageId', 'version']);
      expect(required(body).sort()).toEqual(['toStageId', 'version']);
      const fields = properties(body).get('fields');
      if (!fields) throw new Error('moveDeal has no fields');
      expect(isClosed(fields)).toBe(true);
      expect(keysOf(fields)).toEqual([...REQUIREMENT_FIELDS].sort());
      for (const [key, value] of properties(fields))
        expect(types(value), key).not.toContain('null');
      expect(properties(fields).get('amount')?.node).toBe(schemaNamed('DealMoney').node);
      const checks = properties(body).get('checks');
      const items = checks ? child(checks, 'items') : undefined;
      expect(items ? formatOf(items) : '').toBe('uuid');
      expect(isMapping(checks?.node) ? checks?.node.uniqueItems : undefined).toBe(true);
    });
  });

  describe('moves (D-L88, D-P20)', () => {
    it('moveDeal is the only way a stage changes, and fills requirements in its own transaction', () => {
      const text = prose(description(operation('moveDeal')));
      expect(text).toMatch(/\*\*The only way `stageId` changes\*\* \(D-L88\)/);
      expect(text).toMatch(/Lost is reached from any open stage through it/);
      expect(text).toMatch(/written in the move's own transaction/);
      expect(text).toMatch(/commit together or not at all, so a refused move writes nothing/);
      expect(text).toMatch(/A check recorded on the deal stays recorded/);
      expect(text).toMatch(
        /may name only the target stage's own `field` and `check` requirements; anything else is `400` with `details\[\]\.code: not_a_requirement`/,
      );
      expect(text).toMatch(
        /including a move to the deal's current stage, is `409 transition_not_allowed`/,
      );
      expect(text).toMatch(
        /`details\[\]\.code: unknown_reference` at `toStageId`, one body whatever the reason/,
      );
    });

    it('a required field the mover may not read refuses the move whatever its value: no emptiness oracle (R7)', () => {
      const text = prose(description(operation('moveDeal')));
      expect(text).toMatch(
        /A required field the mover may not edit is `403 field_not_editable`\*\* \(D-L88\)/,
      );
      expect(text).toMatch(
        /a required field the mover may not READ refuses the move whatever its value/,
      );
      expect(text).toMatch(/never tells whether a withheld field is empty/);
      expect(text).toMatch(
        /one the mover reads but may not edit refuses the move only when it is unmet/,
      );
    });

    it('requirements_unmet names requirement ids only: its example details are exactly ids of the target stage', () => {
      const text = prose(description(operation('moveDeal')));
      expect(text).toMatch(/`422 requirements_unmet`, whose `details` name requirement ids only/);
      expect(text).toMatch(/never a field value, a label or a field the caller may not read/);
      const unmet = responses(operation('moveDeal')).get('422');
      const [body] = exampleBodies(unmet);
      if (!body) throw new Error('moveDeal 422 has no example');
      expect(body.code).toBe('requirements_unmet');
      expect(body.statusCode).toBe(422);
      const ids = new Set(
        stagesOf(pipelineExample())
          .flatMap((stage) => list(stage.requirements))
          .map((r) => str(r.id)),
      );
      const details = list(body.details);
      expect(details.length).toBeGreaterThan(0);
      const problems: string[] = [];
      for (const detail of details) {
        if (Object.keys(detail).sort().join() !== 'code,path')
          problems.push(`extra keys ${Object.keys(detail).join()}`);
        if (detail.code !== 'requirement_unmet') problems.push(`code ${String(detail.code)}`);
        const match = /^requirements\.(.+)$/.exec(str(detail.path));
        if (!match || !ids.has(match[1] ?? ''))
          problems.push(`path ${str(detail.path)} is not a requirement id`);
      }
      expect(problems).toEqual([]);
      const labels = stagesOf(pipelineExample())
        .flatMap((stage) => list(stage.requirements))
        .map((r) => str(r.label))
        .filter((label) => label !== '');
      expect(
        labels.filter((label) => JSON.stringify(body).includes(label)),
        'a label leaks',
      ).toEqual([]);
    });

    it('the move examples name real target stages and only their requirements; the answer shows the move', () => {
      const stages = stageById(pipelineExample());
      const examples = examplesOf(jsonMedia(requestBody('moveDeal')));
      expect(examples.length).toBeGreaterThanOrEqual(3);
      const kinds = new Set<string>();
      const problems: string[] = [];
      for (const [label, value] of examples) {
        if (!isMapping(value)) continue;
        const target = stages.get(str(value.toStageId));
        if (!target) {
          problems.push(`${label}: toStageId is not a stage`);
          continue;
        }
        kinds.add(str(target.kind));
        const reqs = list(target.requirements);
        const fieldReqs = reqs.filter((r) => r.kind === 'field').map((r) => str(r.field));
        const checkReqs = reqs.filter((r) => r.kind === 'check').map((r) => str(r.id));
        for (const key of Object.keys(isMapping(value.fields) ? value.fields : {})) {
          if (!fieldReqs.includes(key))
            problems.push(`${label}: fields.${key} is not required by the target`);
        }
        for (const id of Array.isArray(value.checks) ? value.checks.map(str) : []) {
          if (!checkReqs.includes(id)) problems.push(`${label}: check ${id} is not the target's`);
        }
      }
      expect(problems).toEqual([]);
      expect([...kinds].sort(), 'an open, a won and a lost move').toEqual(['lost', 'open', 'won']);
      const [, first] = examples[0] ?? [];
      const moved = okExample('moveDeal');
      if (!isMapping(first)) throw new Error('no first move example');
      expect(moved.stageId).toBe(first.toStageId);
      expect(moved.version).toBe(Number(first.version) + 1);
      expect(moved.stageEnteredAt, 'stageEnteredAt is the move time').toBe(moved.updatedAt);
      const ticked = list(moved.checks).filter((c) =>
        (Array.isArray(first.checks) ? first.checks.map(str) : []).includes(str(c.requirementId)),
      );
      expect(ticked.length).toBe(Array.isArray(first.checks) ? first.checks.length : 0);
      for (const check of ticked)
        expect(check.checkedAt, 'a check is recorded when the move is').toBe(moved.stageEnteredAt);
      for (const [key, value] of Object.entries(isMapping(first.fields) ? first.fields : {})) {
        expect(moved[key], `fields.${key} was written`).toEqual(value);
      }
    });

    it('moveDeal records the from and to stage ids in audit, names only otherwise', () => {
      const text = prose(description(operation('moveDeal')));
      expect(text).toMatch(
        /records the from and to stage ids, which are configuration ids \(D-L88\)/,
      );
      expect(text).toMatch(/never their values/);
      expect(text).toMatch(/Entering won or lost sets `closedAt` to it; leaving them clears it/);
    });
  });

  describe('rights per operation (D-L88, D-P18)', () => {
    for (const id of ALL_IDS) {
      it(`${id}: x-kasuwa-rights states every seeded set`, () => {
        const rights = operation(id).op['x-kasuwa-rights'];
        expect(isMapping(rights), 'x-kasuwa-rights missing').toBe(true);
        expect(rights).toEqual(READS.includes(id) ? READ_RIGHTS : WRITE_RIGHTS);
        expect(rightsProblems(id, rights)).toEqual([]);
      });
    }

    it('(self-check, L1) a read that lets the portal in is caught', () => {
      for (const id of READS) {
        const real = operation(id).op['x-kasuwa-rights'];
        const stated = isMapping(real) ? real : {};
        expect(rightsProblems(id, real), `${id}: the real rights`).toEqual([]);
        const planted = { ...stated, client_portal: 'read' };
        expect(rightsProblems(id, planted).length, `${id}: a portal read`).toBeGreaterThan(0);
        const unstated = Object.fromEntries(
          Object.entries(stated).filter(([set]) => set !== 'client_portal'),
        );
        expect(rightsProblems(id, unstated).length, `${id}: an unstated portal`).toBeGreaterThan(0);
      }
    });

    it('the portal reads no pipeline and no deal: an empty list and the one 404 (L1, D-P26)', () => {
      const listing = prose(description(operation('listPipelines')));
      expect(listing).toMatch(
        /\*\*The `client_portal` set reads no pipeline and no deal in this contract \(D-L115\):\*\* D-P26 shows a portal user actors as role labels and never free text such as `nextStep`/,
      );
      expect(listing).toMatch(
        /For it this list is an empty page and every other pipeline or deal read is the one `404 not_found` body; restoring portal reads later is additive/,
      );
      for (const id of ['getPipeline', 'getPipelineBoard', 'listDeals', 'getDeal']) {
        expect(prose(description(operation(id))), id).toMatch(
          /a `client_portal` caller gets the same `404` \(D-L115\)/,
        );
      }
    });

    it('writes need deal.write and are audited; reads need no permission and are not', () => {
      for (const op of gate()) {
        if (WRITES.includes(op.id)) {
          expect(op.op['x-kasuwa-permission'], op.id).toBe('deal.write');
          expect(op.op['x-kasuwa-audited'], op.id).toBe(true);
        } else {
          expect(op.op['x-kasuwa-permission'], op.id).toBeUndefined();
          expect(op.op['x-kasuwa-audited'], op.id).not.toBe(true);
        }
      }
    });

    it("create: the four writing sets; an agent's deal is theirs; another owner needs deal.reassign", () => {
      const text = prose(description(operation('createDeal')));
      expect(text).toMatch(
        /held by the `agent`, `team_lead`, `programme_manager` and `admin` sets and the tenant-admin flag/,
      );
      expect(text).toMatch(
        /`qa_analyst` and `client_portal` get `403 not_permitted`, decided before the body is read/,
      );
      expect(text).toMatch(
        /An agent's deal is theirs:\*\* without `ownerUserId` the owner is the caller/,
      );
      expect(text).toMatch(/needs `deal.reassign` \(`team_lead`, `programme_manager`, `admin`\)/);
      expect(text).toMatch(/`owner_not_self`/);
      expect(text).toMatch(/The tenant-admin flag never lifts field security/);
    });

    it('edit and move: agents their own, the others any; won or lost needs deal.write_any (R4)', () => {
      for (const id of ['updateDeal', 'moveDeal']) {
        const text = prose(description(operation(id)));
        expect(text, id).toMatch(/\*\*Agents (edit|move) their own deals\*\*/);
        expect(text, id).toMatch(
          /`team_lead`, `programme_manager` and `admin` (edit|move) any deal in (the programme|it) \(`deal.write_any`\)/,
        );
      }
      expect(prose(description(operation('updateDeal')))).toMatch(
        /A won or lost deal is edited only with `deal.write_any`/,
      );
      expect(prose(description(operation('moveDeal')))).toMatch(
        /\*\*Leaving won or lost needs `deal.write_any`\.\*\*/,
      );
      expect(prose(description(operation('updateDeal')))).toMatch(/needs `deal.reassign`/);
    });

    it('own acts as none when ownerUserId is withheld: one 403 for every deal (L3)', () => {
      for (const id of ['updateDeal', 'moveDeal']) {
        const text = prose(description(operation(id)));
        expect(text, id).toMatch(
          /\*\*When field security withholds `ownerUserId` from the caller, `own` acts as `none`\*\* \(D-L115\)/,
        );
        expect(text, id).toMatch(
          /the same `403 not_permitted` for every deal, theirs or not, so the answer never tells who owns a deal/,
        );
      }
    });

    it("updateDeal's audit records the before and after owner ids on a reassignment, names otherwise (L8)", () => {
      const text = prose(description(operation('updateDeal')));
      expect(text).toMatch(/\*\*a reassignment records the before and after owners' user ids\*\*/);
      expect(text).toMatch(
        /`null` for no owner; never a name, D-L71, as for contacts\)\. Every other field is recorded by name only/,
      );
    });

    it('pipelines are read by every staff set and written by none here (R13, L1)', () => {
      const text = prose(description(operation('listPipelines')));
      expect(text).toMatch(/\*\*Pipelines are programme-scoped\*\*/);
      expect(text).toMatch(
        /pipeline configuration is `pipeline.write`, admin-only, and not part of this contract/,
      );
    });
  });

  describe('errors and their order', () => {
    for (const expected of EXPECTED) {
      it(`${expected.id}: documents exactly ${expected.responses.join(', ')} and decides ${expected.errorOrder.length} failures in order`, () => {
        const op = operation(expected.id);
        expect([...responses(op).keys()].sort()).toEqual([...expected.responses].sort());
        expect(op.op['x-kasuwa-error-order']).toEqual(expected.errorOrder);
        const documented = [...responses(op).keys()];
        for (const entry of expected.errorOrder) {
          expect(documented, `${entry} is not a documented response`).toContain(
            entry.split(' ')[0],
          );
        }
      });
    }

    it('the order is 404, 403, 400, then 409/422, with one ruled exception on moveDeal (R7)', () => {
      const rank: Record<string, number> = { '404': 0, '403': 1, '400': 2, '409': 3, '422': 4 };
      const problems: string[] = [];
      for (const op of gate()) {
        const order = Array.isArray(op.op['x-kasuwa-error-order'])
          ? op.op['x-kasuwa-error-order'].map(str)
          : [];
        const ranks = order
          .filter((entry) => entry !== '403 not_permitted field_not_editable')
          .map((entry) => rank[entry.split(' ')[0] ?? ''] ?? -1);
        if (ranks.some((value) => value < 0)) problems.push(`${op.id}: unknown status`);
        if (JSON.stringify([...ranks].sort((a, b) => a - b)) !== JSON.stringify(ranks))
          problems.push(`${op.id}: ${order.join(' > ')}`);
        if (op.id !== 'moveDeal' && order.includes('403 not_permitted field_not_editable'))
          problems.push(`${op.id}: the exception is moveDeal's alone`);
      }
      expect(problems).toEqual([]);
      const move = prose(description(operation('moveDeal')));
      expect(move).toMatch(
        /\*\*Order:\*\* `404`, `403` \(the action, and `field_not_editable` on the keys sent\), `400` \(the body, including an unknown stage\), `403 field_not_editable` \(a required field\), `409 stale_write`, `409 transition_not_allowed`, then `422 requirements_unmet`/,
      );
    });

    it('every error on the eight operations uses the shared Error schema; the two new codes are in its enum', () => {
      const shared = jsonSchema(responses(operation('getContact')).get('404'));
      if (!shared) throw new Error('getContact 404 has no schema');
      const strays: string[] = [];
      let count = 0;
      for (const op of gate()) {
        for (const [status, response] of responses(op)) {
          if (!/^[45]\d\d$/.test(status)) continue;
          count += 1;
          if (jsonSchema(response)?.node !== shared.node) strays.push(`${op.id} ${status}`);
        }
      }
      expect(strays).toEqual([]);
      expect(count).toBeGreaterThanOrEqual(28);
      const code = properties(shared).get('code');
      expect(code ? enumOf(code).map(str) : []).toEqual(
        expect.arrayContaining([
          'transition_not_allowed',
          'requirements_unmet',
          'stale_write',
          'not_found',
        ]),
      );
    });

    it('one 404 body for every pipeline and deal operation, whatever the reason', () => {
      const bodies = new Set<unknown>();
      for (const op of gate()) {
        const notFound = responses(op).get('404');
        if (!notFound) continue;
        bodies.add(notFound.node);
        for (const example of exampleBodies(notFound))
          expect(example, op.id).toEqual(NOT_FOUND_BODY);
        expect(exampleBodies(notFound).length, `${op.id} 404 has no example`).toBe(1);
      }
      expect(bodies.size, 'the 404s are not one response').toBe(1);
      const [only] = [...bodies];
      expect(prose(str(isMapping(only) ? only.description : ''))).toMatch(
        /an id that is not a uuid/,
      );
    });

    it('reads never document 403; every 403 is not_permitted with a known detail', () => {
      const problems: string[] = [];
      for (const op of gate()) {
        const forbidden = responses(op).get('403');
        if (READS.includes(op.id)) {
          if (forbidden) problems.push(`${op.id}: a read documents 403`);
          continue;
        }
        if (!forbidden) {
          problems.push(`${op.id}: no 403`);
          continue;
        }
        for (const body of exampleBodies(forbidden)) {
          if (body.code !== 'not_permitted')
            problems.push(`${op.id}: 403 code ${String(body.code)}`);
          for (const detail of list(body.details)) {
            if (!['field_not_editable', 'owner_not_self'].includes(str(detail.code)))
              problems.push(`${op.id}: 403 detail ${str(detail.code)}`);
          }
        }
      }
      expect(problems).toEqual([]);
      const codes = exampleBodies(responses(operation('moveDeal')).get('403')).flatMap((b) =>
        list(b.details).map((d) => str(d.code)),
      );
      expect(codes).toEqual(expect.arrayContaining(['field_not_editable', 'owner_not_self']));
    });

    it('the 400 examples carry the reason codes a screen switches on', () => {
      const bad = responses(operation('moveDeal')).get('400');
      const bodies = exampleBodies(bad);
      for (const body of bodies) expect(body.code).toBe('validation_failed');
      const details = bodies
        .flatMap((body) => list(body.details))
        .map((d) => `${str(d.path)} ${str(d.code)}`);
      expect(details).toEqual(
        expect.arrayContaining([
          'currency field_withheld',
          'cursor invalid_cursor',
          'toStageId unknown_reference',
          'fields.nextStep not_a_requirement',
          'amount.currency unknown_currency',
          'currency unknown_currency',
          'closedSince window_too_long',
          'closedSince invalid_window',
        ]),
      );
    });

    it('moveDeal 409 is stale_write or transition_not_allowed, with an example of each; updateDeal 409 is stale_write', () => {
      const move = exampleBodies(responses(operation('moveDeal')).get('409')).map((b) =>
        str(b.code),
      );
      expect(move.sort()).toEqual(['stale_write', 'transition_not_allowed']);
      const update = exampleBodies(responses(operation('updateDeal')).get('409')).map((b) =>
        str(b.code),
      );
      expect(update).toEqual(['stale_write']);
    });

    it('every answer of the eight operations, errors included, is Cache-Control: no-store', () => {
      const problems: string[] = [];
      let checked = 0;
      for (const op of gate()) {
        for (const [status, response] of responses(op)) {
          checked += 1;
          const schema = cacheControlSchema(response);
          const values = schema ? enumOf(schema) : [];
          if (JSON.stringify(values) !== JSON.stringify(['no-store']))
            problems.push(`${op.id} ${status}: ${schema ? JSON.stringify(values) : 'missing'}`);
        }
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThanOrEqual(36);
    });
  });

  describe('the board (D-P19)', () => {
    it('PipelineBoard and BoardStage are closed; totals is the one optional key', () => {
      const board = schemaNamed('PipelineBoard');
      expect(isClosed(board)).toBe(true);
      expect(keysOf(board)).toEqual(['closedSince', 'pipelineId', 'stages', 'withheldFields']);
      expect(required(board).sort()).toEqual(keysOf(board));
      const withheld = properties(board).get('withheldFields');
      expect(withheld ? enumOf(withheld).map(str) : []).toEqual(WITHHOLDABLE);
      const stage = schemaNamed('BoardStage');
      expect(isClosed(stage)).toBe(true);
      expect(keysOf(stage)).toEqual(['cards', 'count', 'nextCursor', 'stageId', 'totals']);
      expect(required(stage).sort()).toEqual(['cards', 'count', 'nextCursor', 'stageId']);
      const count = properties(stage).get('count')?.node;
      expect(isMapping(count) ? [count.type, count.minimum] : []).toEqual(['integer', 0]);
      const cards = properties(stage).get('cards');
      expect(cards ? child(cards, 'items')?.node : undefined).toBe(schemaNamed('Deal').node);
      const totals = properties(stage).get('totals');
      expect(totals ? child(totals, 'items')?.node : undefined).toBe(
        schemaNamed('StageTotal').node,
      );
      expect(responseSchema('getPipelineBoard', '200').node).toBe(board.node);
    });

    it('counts are exact, scoped and filtered, over the whole stage; totals one per currency (D-P19)', () => {
      const text = prose(description(operation('getPipelineBoard')));
      expect(text).toMatch(/an exact `count`/);
      expect(text).toMatch(
        /computed within the caller's scope, after the filters, over the whole stage and not the page: never capped and never approximate/,
      );
      expect(text).toMatch(/D-P13 stands for record lists/);
      expect(text).toMatch(/A deal with no amount is counted and adds to no total/);
      expect(text).toMatch(/An empty column has `count: 0` and `totals: \[\]`/);
    });

    it('totals are omitted, not emptied, when amount is withheld; a filter on a withheld field is 400 field_withheld', () => {
      const text = prose(description(operation('getPipelineBoard')));
      expect(text).toMatch(
        /every column's `totals` is omitted, not empty, and `withheldFields` lists `amount`/,
      );
      expect(text).toMatch(/Counts stay/);
      expect(text).toMatch(
        /`details\[\]\.code: field_withheld` at the parameter: `owner` on `ownerUserId`, `closeFrom` and `closeTo` on `expectedCloseDate`, `currency` on `amount`/,
      );
      expect(text).toMatch(/There is no amount-band, account, contact or territory filter/);
      const withheld = namedExample('getPipelineBoard', '200', 'amountWithheld');
      expect(withheld.withheldFields).toEqual(['amount']);
      const problems: string[] = [];
      for (const column of list(withheld.stages)) {
        if ('totals' in column) problems.push(`${str(column.stageId)}: totals present`);
        for (const card of list(column.cards)) {
          if ('amount' in card || 'weightedAmount' in card)
            problems.push(`${str(card.id)}: an amount`);
          if (!(Array.isArray(card.withheldFields) && card.withheldFields.includes('amount')))
            problems.push(`${str(card.id)}: amount not listed`);
        }
      }
      expect(problems).toEqual([]);
      expect(list(withheld.stages).flatMap((c) => list(c.cards)).length).toBeGreaterThan(0);
      // And the unwithheld board carries totals on every column.
      const board = namedExample('getPipelineBoard', '200', 'board');
      expect(list(board.stages).filter((column) => !Array.isArray(column.totals)).length).toBe(0);
    });

    it('the board has a column per open stage then won, in position order; lost is not a column', () => {
      const stages = stagesOf(pipelineExample());
      const columns = stages.filter((stage) => stage.kind !== 'lost').map((stage) => str(stage.id));
      for (const label of ['board', 'amountWithheld']) {
        const board = namedExample('getPipelineBoard', '200', label);
        expect(board.pipelineId).toBe(pipelineExample().id);
        expect(
          list(board.stages).map((column) => str(column.stageId)),
          label,
        ).toEqual(columns);
      }
      const one = namedExample('getPipelineBoard', '200', 'oneColumn');
      expect(list(one.stages).length, 'stageId sent: one column').toBe(1);
      expect(prose(description(operation('getPipelineBoard')))).toMatch(
        /\*\*Lost is not a column\*\*/,
      );
    });

    it('cards sit in their column, ordered: open by stageEnteredAt ascending, won by closedAt descending, won since closedSince', () => {
      const kinds = new Map(
        stagesOf(pipelineExample()).map((stage) => [str(stage.id), str(stage.kind)]),
      );
      const problems: string[] = [];
      for (const label of ['board', 'oneColumn', 'amountWithheld']) {
        const board = namedExample('getPipelineBoard', '200', label);
        const since = Date.parse(str(board.closedSince));
        for (const column of list(board.stages)) {
          const cards = list(column.cards);
          if (Number(column.count) < cards.length)
            problems.push(`${label}: count below the cards shown`);
          if (column.nextCursor !== null && Number(column.count) <= cards.length)
            problems.push(`${label}: a cursor on a complete column`);
          for (const card of cards) {
            if (card.stageId !== column.stageId)
              problems.push(`${label}: ${str(card.id)} in the wrong column`);
          }
          const won = kinds.get(str(column.stageId)) === 'won';
          const keys = cards.map((card) =>
            Date.parse(str(won ? card.closedAt : card.stageEnteredAt)),
          );
          const sorted = [...keys].sort((a, b) => (won ? b - a : a - b));
          if (JSON.stringify(sorted) !== JSON.stringify(keys))
            problems.push(`${label}: ${str(column.stageId)} out of order`);
          if (won && keys.some((key) => key < since))
            problems.push(`${label}: a won card before closedSince`);
        }
      }
      expect(problems).toEqual([]);
      const text = prose(description(operation('getPipelineBoard')));
      expect(text).toMatch(/default 90 days before the request \(D-L88\)/);
      expect(text).toMatch(/Open columns ignore `closedSince`/);
      expect(text).toMatch(
        /Open columns are ordered by `stageEnteredAt` ascending, ties broken by `id` ascending/,
      );
      expect(text).toMatch(
        /the won column by `closedAt` descending, ties broken by `id` descending/,
      );
    });

    it('paging a column keeps its whole-stage count and totals', () => {
      const board = namedExample('getPipelineBoard', '200', 'board');
      const one = namedExample('getPipelineBoard', '200', 'oneColumn');
      const [page] = list(one.stages);
      const first = list(board.stages).find((column) => column.stageId === page?.stageId);
      if (!page || !first) throw new Error('the oneColumn example names no board column');
      expect(first.nextCursor, 'the paged column has a cursor on the board').not.toBeNull();
      expect(page.count).toBe(first.count);
      expect(page.totals).toEqual(first.totals);
      const shown = new Set(list(first.cards).map((card) => str(card.id)));
      expect(
        list(page.cards).filter((card) => shown.has(str(card.id))),
        'a card repeats',
      ).toEqual([]);
      expect(prose(description(operation('getPipelineBoard')))).toMatch(
        /its `count` and `totals` still for the whole stage/,
      );
    });
  });

  describe('the hidden list (D-L88)', () => {
    it('(self-check) the detector catches each hidden concept by name and passes the real ones', () => {
      gate(); // Not vacuous on main: this helper would pass before the work starts.
      const planted = [
        'usdAmount',
        'fxRate',
        'amountUsd',
        'territoryId',
        'aiRisk',
        'riskScore',
        'products',
        'priceBook',
        'quoteId',
        'approvalStatus',
        'pendingApprover',
        'attachments',
        'lastWhatsappAt',
        'last_whatsapp_contact',
        'contactRoles',
        'competitors',
        'kycLocked',
        'lockedChecks',
        'ninLast4',
        'bvnVerified',
        'loanTemplate',
        'templateId',
        'showUS$',
      ];
      expect(planted.filter((name) => hiddenWordsIn(name).length === 0)).toEqual([]);
      const real = [
        'amount',
        'weightedAmount',
        'stageId',
        'primaryContactId',
        'rottingAfterDays',
        'requirements',
        'checks',
        'closedSince',
      ];
      expect(real.filter((name) => hiddenWordsIn(name).length > 0)).toEqual([]);
    });

    it('no hidden concept in an operation id, path, tag or parameter name', () => {
      const offending: string[] = [];
      for (const op of gate()) {
        const names = [op.id, op.path, ...(Array.isArray(op.op.tags) ? op.op.tags.map(str) : [])];
        for (const parameter of op.params) names.push(str(parameter.name));
        for (const name of names) {
          const hit = hiddenWordsIn(name);
          if (hit.length > 0) offending.push(`${op.id}: ${name} (${hit.join(', ')})`);
        }
      }
      expect(offending).toEqual([]);
    });

    it('no hidden concept in any property, at any depth, of any schema the eight operations reach', () => {
      const offending: string[] = [];
      let inspected = 0;
      for (const [where, schema] of touchedSchemas()) {
        for (const path of deepKeys(schema)) {
          inspected += 1;
          const hit = hiddenWordsIn(leafOf(path));
          if (hit.length > 0) offending.push(`${where}: ${path}`);
        }
      }
      for (const op of gate()) {
        for (const parameter of op.params) {
          for (const path of deepKeys(paramSchema(parameter))) {
            if (hiddenWordsIn(leafOf(path)).length > 0)
              offending.push(`${op.id} ${str(parameter.name)}: ${path}`);
          }
        }
      }
      expect(offending).toEqual([]);
      expect(inspected, 'no property inspected').toBeGreaterThan(80);
    });

    it('no hidden concept in an enum value (no pending-approval stage kind, no KYC requirement field)', () => {
      const offending: string[] = [];
      let inspected = 0;
      for (const [where, schema] of touchedSchemas()) {
        for (const value of deepEnums(schema)) {
          inspected += 1;
          if (hiddenWordsIn(value).length > 0) offending.push(`${where}: ${value}`);
        }
      }
      for (const op of gate()) {
        for (const parameter of op.params) {
          for (const value of deepEnums(paramSchema(parameter))) {
            if (hiddenWordsIn(value).length > 0)
              offending.push(`${op.id} ${str(parameter.name)}: ${value}`);
          }
        }
      }
      expect(offending).toEqual([]);
      expect(inspected).toBeGreaterThan(15);
    });

    it('no x-kasuwa extension names a hidden concept, and no example text names the Loans template, KYC, NIN, BVN or US$', () => {
      const offending: string[] = [];
      for (const op of gate()) {
        for (const key of Object.keys(op.op).filter((k) => k.startsWith('x-'))) {
          if (hiddenWordsIn(key.slice(2)).length > 0) offending.push(`${op.id}: ${key}`);
        }
        const holders = [
          op.op.requestBody === undefined ? undefined : at(op.op.requestBody),
          ...responses(op).values(),
        ];
        for (const holder of holders) {
          for (const [label, value] of examplesOf(jsonMedia(holder))) {
            for (const text of stringsIn(value)) {
              if (hiddenWordsIn(text, HIDDEN_IN_TEXT).length > 0)
                offending.push(`${op.id} ${label}: ${text}`);
            }
          }
        }
      }
      expect(offending).toEqual([]);
    });
  });

  describe('examples are valid against their schemas', () => {
    it('(self-check) the validator rejects broken copies of the contract examples', () => {
      const dealSchema = schemaNamed('Deal');
      const deal = okExample('getDeal');
      expect(validate(dealSchema, deal, 'deal'), 'the unbroken example').toEqual([]);
      const mutants: [string, unknown][] = [
        ['a float amount', { ...deal, amount: { amountMinor: 15000000.15, currency: 'NGN' } }],
        ['a decimal string', { ...deal, amount: { amountMinor: '15000000.15', currency: 'NGN' } }],
        ['a symbol', { ...deal, amount: { amountMinor: '1', currency: '₦' } }],
        [
          'a converted amount',
          { ...deal, amount: { amountMinor: '1', currency: 'NGN', usd: '1' } },
        ],
        ['a probability', { ...deal, probabilityBp: 7000 }],
        ['a rotting state', { ...deal, rotting: 'old' }],
        ['a datetime close date', { ...deal, expectedCloseDate: '2026-10-31T00:00:00.000Z' }],
        ['an impossible close date', { ...deal, expectedCloseDate: '2026-02-30' }],
        ['an unknown withheld name', { ...deal, withheldFields: ['name'] }],
        ['a repeated withheld name', { ...deal, withheldFields: ['amount', 'amount'] }],
        [
          'a contact with a phone',
          { ...deal, contact: { id: deal.id, displayName: 'A', phone: '+2348030000000' } },
        ],
        ['a version above int4', { ...deal, version: 2147483648 }],
        ['no stageId', JSON.parse(JSON.stringify({ ...deal, stageId: undefined })) as unknown],
      ];
      for (const [label, mutant] of mutants) {
        expect(validate(dealSchema, mutant, 'deal').length, `accepted ${label}`).toBeGreaterThan(0);
      }
      const update = requestSchema('updateDeal');
      for (const [label, body] of [
        ['a stage change', { version: 2, stageId: deal.stageId }],
        ['version only', { version: 2 }],
        ['no version', { name: 'x' }],
        ['a programme move', { version: 2, programmeId: deal.programmeId }],
      ] as const) {
        expect(
          validate(update, body, 'body').length,
          `updateDeal accepted ${label}`,
        ).toBeGreaterThan(0);
      }
      const move = requestSchema('moveDeal');
      for (const [label, body] of [
        ['a null field', { version: 2, toStageId: deal.stageId, fields: { nextStep: null } }],
        ['a non-requirement field', { version: 2, toStageId: deal.stageId, fields: { name: 'x' } }],
        ['empty fields', { version: 2, toStageId: deal.stageId, fields: {} }],
        ['a repeated check', { version: 2, toStageId: deal.stageId, checks: [deal.id, deal.id] }],
        ['no target', { version: 2 }],
      ] as const) {
        expect(validate(move, body, 'body').length, `moveDeal accepted ${label}`).toBeGreaterThan(
          0,
        );
      }
      const board = schemaNamed('PipelineBoard');
      const example = namedExample('getPipelineBoard', '200', 'board');
      const [column] = list(example.stages);
      expect(validate(board, example, 'board')).toEqual([]);
      for (const [label, mutant] of [
        [
          'a float total',
          {
            ...example,
            stages: [
              {
                ...column,
                totals: [{ currency: 'NGN', amountMinor: 1.5, weightedAmountMinor: '1' }],
              },
            ],
          },
        ],
        [
          'a total with a rate',
          {
            ...example,
            stages: [
              {
                ...column,
                totals: [
                  { currency: 'NGN', amountMinor: '1', weightedAmountMinor: '1', rate: '1' },
                ],
              },
            ],
          },
        ],
        ['a negative count', { ...example, stages: [{ ...column, count: -1 }] }],
        [
          'a column with no count',
          {
            ...example,
            stages: [JSON.parse(JSON.stringify({ ...column, count: undefined })) as unknown],
          },
        ],
        ['a board total', { ...example, total: 9 }],
      ] as const) {
        expect(validate(board, mutant, 'board').length, `accepted ${label}`).toBeGreaterThan(0);
      }
      const stage = schemaNamed('PipelineStage');
      const [qualified] = stagesOf(pipelineExample());
      expect(
        validate(stage, { ...qualified, kind: 'pending_approval' }, 's').length,
      ).toBeGreaterThan(0);
      expect(validate(stage, { ...qualified, probabilityBp: 10001 }, 's').length).toBeGreaterThan(
        0,
      );
      expect(validate(stage, { ...qualified, probabilityBp: 0.25 }, 's').length).toBeGreaterThan(0);
      expect(
        validate(
          stage,
          { ...qualified, requirements: [{ id: deal.id, kind: 'field', field: 'bvn' }] },
          's',
        ).length,
      ).toBeGreaterThan(0);
      expect(
        validate(stage, { ...qualified, requirements: [{ id: deal.id, kind: 'approval' }] }, 's')
          .length,
      ).toBeGreaterThan(0);
    });

    it('every request and response example on the eight operations validates', () => {
      const problems: string[] = [];
      let checked = 0;
      for (const op of gate()) {
        const body = op.op.requestBody === undefined ? undefined : at(op.op.requestBody);
        const bodySchema = jsonSchema(body);
        for (const [label, value] of examplesOf(jsonMedia(body))) {
          checked += 1;
          if (bodySchema)
            problems.push(...validate(bodySchema, value, `${op.id} request ${label}`));
        }
        for (const [status, response] of responses(op)) {
          const schema = jsonSchema(response);
          const examples = examplesOf(jsonMedia(response));
          if (examples.length === 0) problems.push(`${op.id} ${status}: no example`);
          for (const [label, value] of examples) {
            checked += 1;
            if (schema) problems.push(...validate(schema, value, `${op.id} ${status} ${label}`));
          }
        }
      }
      expect(problems).toEqual([]);
      // Eight success answers (three board views), five request bodies and the error examples.
      expect(checked).toBeGreaterThanOrEqual(60);
    });

    it('every other example in the file still validates (D-L97: widening one schema breaks no mock)', () => {
      gate(); // Not vacuous on main: this holds before the work starts.
      const problems: string[] = [];
      let checked = 0;
      for (const op of operations()) {
        if (ALL_IDS.includes(op.id)) continue;
        const body = op.op.requestBody === undefined ? undefined : at(op.op.requestBody);
        const bodySchema = jsonSchema(body);
        for (const [label, value] of examplesOf(jsonMedia(body))) {
          checked += 1;
          if (bodySchema)
            problems.push(...validate(bodySchema, value, `${op.id} request ${label}`));
        }
        for (const [status, response] of responses(op)) {
          const schema = jsonSchema(response);
          for (const [label, value] of examplesOf(jsonMedia(response))) {
            checked += 1;
            if (schema) problems.push(...validate(schema, value, `${op.id} ${status} ${label}`));
          }
        }
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThan(20);
    });
  });
});
