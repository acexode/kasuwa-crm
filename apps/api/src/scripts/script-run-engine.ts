import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  codePoints,
  INT32_MAX,
  INT32_MIN,
  SCRIPT_LOCALES,
  type ScriptLocale,
  type ScriptNode,
  type StoredGraph,
  type Translations,
} from './script-graph';

/**
 * How a run moves through a published script (T-0114; the run operations of
 * docs/api/scripting.openapi.yaml; D-L88, D-L91, D-L93). PURE: no database,
 * no clock of its own (the caller passes `now`), no logging. The service
 * loads, decides with these functions, then writes.
 *
 *   - The server picks every next node. A `branch` is evaluated on ENTRY and
 *     never becomes the current node, unless it stops the run: a branch on a
 *     contact field withheld from the run's agent stops it with
 *     `field_withheld`, one on a field classified `sensitive` since publish
 *     with `sensitive_field` (D-L93). The value is never read in either case,
 *     so the stop is the same whatever the value is (R7).
 *   - Compliance nodes must be acknowledged (server time) before the run moves
 *     past them, and before a `completed` completion.
 *   - Form answers are validated against the field's rules; a refusal names
 *     `values.<key>` and a reason code, never the value (answers are
 *     `sensitive`).
 *
 * Everything returned as a refusal is a `{ path, code }` detail: node ids,
 * field keys and codes. Those details go to the run's own agent only and are
 * never logged or traced (the contract's "Run error details").
 */

/** 256 KiB: a run's answers together, serialised, in UTF-8 bytes (D-L93, N9). */
export const RUN_ANSWERS_MAX_BYTES = 262_144;

/** The most entries a run's path, acknowledgements or unread list may hold (ScriptRun). */
export const RUN_LIST_MAX = 200;

/** Most days ahead a callback may be booked (D-L93). */
export const FOLLOW_UP_MAX_DAYS = 366;

export type RunStatus = 'in_progress' | 'stopped' | 'completed';
export type RunOutcome = 'completed' | 'interrupted' | 'superseded';
export type StopReason = 'field_withheld' | 'sensitive_field';

export interface RunStep {
  nodeId: string;
  enteredAt: string;
  /** On a branch step only; `null` when the branch stopped the run. */
  branchOutcome?: boolean | null;
}

export interface RunAcknowledgement {
  nodeId: string;
  locale: ScriptLocale;
  profileLocale: ScriptLocale | null;
  acknowledgedAt: string;
}

export interface MoneyValue {
  amountMinor: string;
  currency: string;
}

export type AnswerValue = string | number | MoneyValue;

export interface QuestionAnswer {
  type: 'question';
  choiceKey: string;
  answeredAt: string;
}

export interface FormAnswer {
  type: 'form';
  values: Record<string, AnswerValue>;
  updatedAt: string;
}

export type NodeAnswer = QuestionAnswer | FormAnswer;
export type RunAnswers = Record<string, NodeAnswer>;

export interface RunDetail {
  path: string;
  code: string;
}

export type FormNode = Extract<ScriptNode, { type: 'form' }>;
export type FormField = FormNode['fields'][number];
export type BranchNode = Extract<ScriptNode, { type: 'branch' }>;

// --- stored shapes -------------------------------------------------------------
// The run's jsonb columns, as this module writes them. Parsed on the way out of
// the database so a row no write path produces is an empty list, never a crash
// and never a value passed on unchecked.

const StoredStep = z
  .object({
    nodeId: z.string(),
    enteredAt: z.string(),
    branchOutcome: z.boolean().nullable().optional(),
  })
  .strict();

const StoredAck = z
  .object({
    nodeId: z.string(),
    locale: z.enum(SCRIPT_LOCALES),
    profileLocale: z.enum(SCRIPT_LOCALES).nullable(),
    acknowledgedAt: z.string(),
  })
  .strict();

const StoredMoney = z.object({ amountMinor: z.string(), currency: z.string() }).strict();
const StoredValue = z.union([z.string(), z.number(), StoredMoney]);

const StoredAnswer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('question'), choiceKey: z.string(), answeredAt: z.string() }).strict(),
  z
    .object({
      type: z.literal('form'),
      values: z.record(z.string(), StoredValue),
      updatedAt: z.string(),
    })
    .strict(),
]);

export function storedPath(value: unknown): RunStep[] {
  const parsed = z.array(StoredStep).safeParse(value);
  if (!parsed.success) return [];
  // A branchOutcome key only on a branch step, never an explicit undefined.
  return parsed.data.map(({ nodeId, enteredAt, branchOutcome }) =>
    branchOutcome === undefined ? { nodeId, enteredAt } : { nodeId, enteredAt, branchOutcome },
  );
}

export function storedAcknowledgements(value: unknown): RunAcknowledgement[] {
  const parsed = z.array(StoredAck).safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function storedAnswers(value: unknown): RunAnswers {
  const parsed = z.record(z.string(), StoredAnswer).safeParse(value);
  return parsed.success ? (parsed.data as RunAnswers) : {};
}

// --- the graph -------------------------------------------------------------------

export function nodesById(graph: StoredGraph): Map<string, ScriptNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

/** The serialised size of a run's answers, in UTF-8 bytes (what the cap counts). */
export function answersBytes(answers: RunAnswers): number {
  return Buffer.byteLength(JSON.stringify(answers), 'utf8');
}

// --- branches ----------------------------------------------------------------------

/** What the server may know about one contact field, for the run's agent, right now. */
export type FieldReading =
  | { kind: 'value'; value: unknown }
  | { kind: 'withheld' }
  | { kind: 'sensitive' };

export type FieldReader = (field: string) => Promise<FieldReading>;

type Condition = BranchNode['condition'];

function isMoney(value: unknown): value is MoneyValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { amountMinor?: unknown }).amountMinor === 'string'
  );
}

/**
 * "A missing or `null` value is not set, and every comparison with it is
 * false" (ConditionOperator). An empty list (no tags, no phones) is not set
 * either: there is nothing to compare.
 */
function isSet(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** A scalar as comparable: a money answer compares by its minor units. */
function scalar(value: unknown): unknown {
  return isMoney(value) ? value.amountMinor : value;
}

function same(actual: unknown, expected: unknown): boolean {
  const left = scalar(actual);
  if (typeof left === 'string' && typeof expected === 'number') return left === String(expected);
  return left === expected;
}

function numeric(value: unknown): bigint | null {
  const left = scalar(value);
  if (typeof left === 'number' && Number.isInteger(left)) return BigInt(left);
  if (typeof left === 'string' && isMoney(value)) return BigInt(left);
  return null;
}

/** Whether `condition` holds for `actual` (a contact field's or an answer's value). */
export function conditionHolds(
  condition: { operator: Condition['operator']; value?: unknown },
  actual: unknown,
): boolean {
  const { operator, value: expected } = condition;
  if (operator === 'is_set') return isSet(actual);
  if (operator === 'is_not_set') return !isSet(actual);
  if (!isSet(actual)) return false;
  const values: unknown[] = Array.isArray(actual) ? actual : [actual];
  switch (operator) {
    case 'equals':
      return values.some((item) => same(item, expected));
    case 'not_equals':
      return !values.some((item) => same(item, expected));
    case 'one_of':
      return (
        Array.isArray(expected) &&
        values.some((item) => expected.some((option) => same(item, option)))
      );
    case 'greater_than':
    case 'less_than': {
      if (typeof expected !== 'number' || Array.isArray(actual)) return false;
      const left = numeric(actual);
      if (left === null) return false;
      const right = BigInt(expected);
      return operator === 'greater_than' ? left > right : left < right;
    }
  }
}

/** The answer a branch on `source: answer` reads: a question's choice, or a form field's value. */
export function answerValue(answers: RunAnswers, nodeId: string, fieldKey?: string): unknown {
  const answer = Object.prototype.hasOwnProperty.call(answers, nodeId) ? answers[nodeId] : undefined;
  if (answer === undefined) return undefined;
  if (fieldKey === undefined) return answer.type === 'question' ? answer.choiceKey : undefined;
  if (answer.type !== 'form') return undefined;
  return Object.prototype.hasOwnProperty.call(answer.values, fieldKey)
    ? answer.values[fieldKey]
    : undefined;
}

export interface Entered {
  path: RunStep[];
  currentNodeId: string;
  stopReason: StopReason | null;
}

/** A published graph that sends a run nowhere: a defect publish refuses, never a user error. */
export class BrokenPublishedGraphError extends Error {
  constructor() {
    super('A published script version names a node it does not have');
    this.name = 'BrokenPublishedGraphError';
  }
}

/**
 * Enters `nodeId`, appending to `path`, and follows branches on the server
 * until the run rests on a node that is not a branch, or a branch stops it.
 * A branch step records the side taken (`branchOutcome`), or `null` when it
 * stopped the run. Published graphs are acyclic (publish refuses a cycle),
 * so this ends; the bound is a second guard.
 */
export async function enterNode(
  graph: StoredGraph,
  nodeId: string,
  path: readonly RunStep[],
  answers: RunAnswers,
  readField: FieldReader,
  now: string,
): Promise<Entered> {
  const byId = nodesById(graph);
  const steps = [...path];
  let target = nodeId;
  for (let hops = 0; hops <= graph.nodes.length; hops += 1) {
    const node = byId.get(target);
    if (node === undefined) throw new BrokenPublishedGraphError();
    if (node.type !== 'branch') {
      steps.push({ nodeId: node.id, enteredAt: now });
      return { path: steps, currentNodeId: node.id, stopReason: null };
    }
    const { condition } = node;
    let actual: unknown;
    if (condition.source === 'contact_field') {
      const reading = await readField(condition.field);
      if (reading.kind !== 'value') {
        // Following either side would tell the agent something about a value
        // they may not read (D-L93): stop here, whatever the value is.
        steps.push({ nodeId: node.id, enteredAt: now, branchOutcome: null });
        return {
          path: steps,
          currentNodeId: node.id,
          stopReason: reading.kind === 'sensitive' ? 'sensitive_field' : 'field_withheld',
        };
      }
      actual = reading.value;
    } else {
      actual = answerValue(answers, condition.nodeId, condition.fieldKey);
    }
    const outcome = conditionHolds(condition, actual);
    steps.push({ nodeId: node.id, enteredAt: now, branchOutcome: outcome });
    target = outcome ? node.whenTrue : node.whenFalse;
  }
  throw new BrokenPublishedGraphError();
}

/** The contact field a stopped run's branch reads, or null when it reads none. */
export function stoppedOnField(graph: StoredGraph, currentNodeId: string | null): string | null {
  if (currentNodeId === null) return null;
  const node = nodesById(graph).get(currentNodeId);
  return node?.type === 'branch' && node.condition.source === 'contact_field'
    ? node.condition.field
    : null;
}

// --- advance -----------------------------------------------------------------------

/** advanceScriptRun's semantic 400: the choice on a question, and only on a question. */
export function choiceProblem(node: ScriptNode, choiceKey: string | undefined): RunDetail | null {
  if (node.type === 'question') {
    if (choiceKey === undefined) return { path: 'choiceKey', code: 'required' };
    return node.choices.some((choice) => choice.key === choiceKey)
      ? null
      : { path: 'choiceKey', code: 'unknown_choice' };
  }
  return choiceKey === undefined ? null : { path: 'choiceKey', code: 'not_a_question' };
}

export function isAcknowledged(acks: readonly RunAcknowledgement[], nodeId: string): boolean {
  return acks.some((ack) => ack.nodeId === nodeId);
}

/** The required fields of a form node with no answer on the run, as `values.<key>`. */
export function missingRequired(node: FormNode, answers: RunAnswers): RunDetail[] {
  const answer = answers[node.id];
  const values = answer?.type === 'form' ? answer.values : {};
  return node.fields
    .filter(
      (field) =>
        field.required &&
        (!Object.prototype.hasOwnProperty.call(values, field.key) || values[field.key] === null),
    )
    .map((field) => ({ path: `values.${field.key}`, code: 'required' }));
}

export type AdvanceDecision =
  | { kind: 'next'; nodeId: string }
  | { kind: 'run_at_end' }
  | { kind: 'compliance_unacknowledged'; details: RunDetail[] }
  | { kind: 'answers_incomplete'; details: RunDetail[] };

/**
 * Where the run goes from `node`, or why it may not move, in the published
 * order (run_at_end, compliance_unacknowledged, answers_incomplete). The
 * choice has already been judged by `choiceProblem`.
 */
export function advanceFrom(
  node: ScriptNode,
  acks: readonly RunAcknowledgement[],
  answers: RunAnswers,
  choiceKey: string | undefined,
): AdvanceDecision {
  switch (node.type) {
    case 'end':
      return { kind: 'run_at_end' };
    case 'compliance':
      return isAcknowledged(acks, node.id)
        ? { kind: 'next', nodeId: node.next }
        : {
            kind: 'compliance_unacknowledged',
            details: [{ path: `nodes.${node.id}`, code: 'not_acknowledged' }],
          };
    case 'form': {
      const missing = missingRequired(node, answers);
      return missing.length > 0
        ? { kind: 'answers_incomplete', details: missing }
        : { kind: 'next', nodeId: node.next };
    }
    case 'question': {
      const choice = node.choices.find((candidate) => candidate.key === choiceKey);
      if (choice === undefined) throw new BrokenPublishedGraphError(); // judged before
      return { kind: 'next', nodeId: choice.next };
    }
    case 'say':
      return { kind: 'next', nodeId: node.next };
    case 'branch':
      // A branch is never a resting node unless it stopped the run, and a
      // stopped run never reaches here (409 run_stopped first).
      throw new BrokenPublishedGraphError();
  }
}

// --- acknowledgements ------------------------------------------------------------

/** acknowledgeScriptRunNode's semantic 400: a compliance node on the run's path. */
export function acknowledgeProblem(
  graph: StoredGraph,
  path: readonly RunStep[],
  nodeId: string,
): RunDetail | null {
  if (!path.some((step) => step.nodeId === nodeId)) return { path: 'nodeId', code: 'not_on_path' };
  const node = nodesById(graph).get(nodeId);
  return node?.type === 'compliance' ? null : { path: 'nodeId', code: 'not_compliance' };
}

/**
 * The locale an acknowledgement records: the one the client reports, unless
 * the pinned version's translation for it has no `text` for the node, when
 * the screen showed the source wording, so the source locale.
 */
export function acknowledgedLocale(
  reported: ScriptLocale,
  sourceLocale: ScriptLocale,
  translations: Translations,
  nodeId: string,
): ScriptLocale {
  if (reported === sourceLocale) return sourceLocale;
  const texts = translations[reported];
  const translation =
    texts !== undefined && Object.prototype.hasOwnProperty.call(texts, nodeId)
      ? texts[nodeId]
      : undefined;
  return translation?.text === undefined ? sourceLocale : reported;
}

/** The agent's profile locale when it is exactly one of the seven, else null (R9). */
export function profileLocaleOf(locale: string | null): ScriptLocale | null {
  return locale !== null && (SCRIPT_LOCALES as readonly string[]).includes(locale)
    ? (locale as ScriptLocale)
    : null;
}

// --- answers -----------------------------------------------------------------------

/** recordScriptRunAnswers' semantic 400 on the node: a form node on the run's path. */
export function answerNodeProblem(
  graph: StoredGraph,
  path: readonly RunStep[],
  nodeId: string,
): { node: FormNode } | { problem: RunDetail } {
  if (!path.some((step) => step.nodeId === nodeId)) {
    return { problem: { path: 'nodeId', code: 'not_on_path' } };
  }
  const node = nodesById(graph).get(nodeId);
  return node?.type === 'form' ? { node } : { problem: { path: 'nodeId', code: 'not_a_form' } };
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MINOR_UNITS = /^[0-9]{1,18}$/;
const CURRENCY = /^[A-Z]{3}$/;

/** Days since 1970-01-01 for a real calendar date `YYYY-MM-DD`, or null. */
function dayNumber(value: string): number | null {
  const match = DATE.exec(value);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = Date.UTC(year, month - 1, day);
  const back = new Date(at);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return null;
  }
  return at / 86_400_000;
}

/** Today in `timeZone`, as `YYYY-MM-DD`. */
export function todayIn(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The reason code a value earns against its field, or null when it fits. Never the value. */
export function fieldValueProblem(field: FormField, value: unknown, today: string): string | null {
  switch (field.type) {
    case 'text': {
      if (typeof value !== 'string') return 'invalid_type';
      return codePoints(value) > (field.maxLength ?? 2000) ? 'too_big' : null;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'invalid_type';
      if (value < INT32_MIN) return 'too_small';
      if (value > INT32_MAX) return 'too_big';
      if (field.minimum !== undefined && value < field.minimum) return 'too_small';
      if (field.maximum !== undefined && value > field.maximum) return 'too_big';
      return null;
    }
    case 'money': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid_type';
      const keys = Object.keys(value).sort();
      if (keys.length !== 2 || keys[0] !== 'amountMinor' || keys[1] !== 'currency') {
        return 'invalid_type';
      }
      const { amountMinor, currency } = value as { amountMinor: unknown; currency: unknown };
      if (typeof amountMinor !== 'string' || !MINOR_UNITS.test(amountMinor)) return 'invalid_money';
      if (typeof currency !== 'string' || !CURRENCY.test(currency)) return 'invalid_currency';
      // One currency per field, never converted.
      if (currency !== field.currency) return 'currency_mismatch';
      const amount = BigInt(amountMinor);
      if (field.minimumMinor !== undefined && amount < BigInt(field.minimumMinor)) return 'too_small';
      if (field.maximumMinor !== undefined && amount > BigInt(field.maximumMinor)) return 'too_big';
      return null;
    }
    case 'date': {
      if (typeof value !== 'string') return 'invalid_type';
      const day = dayNumber(value);
      const base = dayNumber(today);
      if (day === null || base === null) return 'invalid_date';
      const ahead = day - base;
      if (ahead < (field.minDaysAhead ?? Number.NEGATIVE_INFINITY)) return 'too_small';
      if (ahead > (field.maxDaysAhead ?? Number.POSITIVE_INFINITY)) return 'too_big';
      return null;
    }
    case 'choice': {
      if (typeof value !== 'string') return 'invalid_type';
      return (field.options ?? []).some((option) => option.key === value) ? null : 'not_an_option';
    }
  }
}

/**
 * Every problem with a save's `values` against the form node, as
 * `values.<key>` and a code: a key the node does not have, or a value that
 * breaks its field's rules. `null` clears a value and always fits.
 */
export function answerProblems(
  node: FormNode,
  values: Readonly<Record<string, unknown>>,
  today: string,
): RunDetail[] {
  const fields = new Map(node.fields.map((field) => [field.key, field]));
  const problems: RunDetail[] = [];
  for (const [key, value] of Object.entries(values)) {
    const field = fields.get(key);
    if (field === undefined) {
      problems.push({ path: `values.${key}`, code: 'unknown_field_key' });
      continue;
    }
    if (value === null) continue;
    const code = fieldValueProblem(field, value, today);
    if (code !== null) problems.push({ path: `values.${key}`, code });
  }
  return problems;
}

/** The node's answers after a save: merged per key, `null` removes the key. */
export function mergeFormAnswer(
  answers: RunAnswers,
  nodeId: string,
  values: Readonly<Record<string, unknown>>,
  now: string,
): RunAnswers {
  const current = answers[nodeId];
  const merged: Record<string, AnswerValue> = current?.type === 'form' ? { ...current.values } : {};
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete merged[key];
    else merged[key] = value as AnswerValue;
  }
  return { ...answers, [nodeId]: { type: 'form', values: merged, updatedAt: now } };
}

// --- completion --------------------------------------------------------------------

/** Every compliance node on the path, in the order first entered. */
export function complianceOnPath(graph: StoredGraph, path: readonly RunStep[]): string[] {
  const byId = nodesById(graph);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const step of path) {
    if (seen.has(step.nodeId)) continue;
    seen.add(step.nodeId);
    if (byId.get(step.nodeId)?.type === 'compliance') ids.push(step.nodeId);
  }
  return ids;
}

export interface CompletionSubject {
  status: RunStatus;
  currentNodeId: string | null;
  path: readonly RunStep[];
  acknowledgements: readonly RunAcknowledgement[];
}

export type CompletionDecision =
  | { kind: 'refused'; details: RunDetail[] }
  | { kind: 'allowed'; unacknowledged: string[] };

/**
 * completeScriptRun's `409 compliance_unacknowledged` (D-L91, D-L93), or what
 * the run records:
 *   - `completed` only at an `end` node or on a `stopped` run (otherwise
 *     `{ path: outcome, code: not_at_end }`), and only with every compliance
 *     node on the path acknowledged, the current one included;
 *   - `interrupted` anywhere: every compliance node already PASSED must be
 *     acknowledged (advance guarantees it); the current node and any node not
 *     yet reached are excused, and every unread one on the path is recorded.
 *     Nothing is acknowledged by completing.
 */
export function completionDecision(
  graph: StoredGraph,
  run: CompletionSubject,
  outcome: 'completed' | 'interrupted',
): CompletionDecision {
  const unread = complianceOnPath(graph, run.path).filter(
    (nodeId) => !isAcknowledged(run.acknowledgements, nodeId),
  );
  const notAcknowledged = (ids: readonly string[]): RunDetail[] =>
    ids.map((nodeId) => ({ path: `nodes.${nodeId}`, code: 'not_acknowledged' }));
  if (outcome === 'completed') {
    const current = run.currentNodeId === null ? undefined : nodesById(graph).get(run.currentNodeId);
    if (run.status !== 'stopped' && current?.type !== 'end') {
      return { kind: 'refused', details: [{ path: 'outcome', code: 'not_at_end' }] };
    }
    return unread.length > 0
      ? { kind: 'refused', details: notAcknowledged(unread) }
      : { kind: 'allowed', unacknowledged: [] };
  }
  const passed = unread.filter((nodeId) => nodeId !== run.currentNodeId);
  return passed.length > 0
    ? { kind: 'refused', details: notAcknowledged(passed) }
    : { kind: 'allowed', unacknowledged: unread };
}

/** The parts of a completion request that make an exact repeat (D-L91). */
export interface CompletionRequest {
  outcome: 'completed' | 'interrupted';
  dispositionId: string;
  note?: string | undefined;
  followUp?: { dueAt: string } | undefined;
}

/**
 * A digest of the completing request: the same outcome, disposition, note and
 * follow-up give the same digest whatever `revision` the request carries, so
 * a repeat is recognised without keeping a second copy of the note. The time
 * is compared as an instant, not as text.
 */
export function completionDigest(request: CompletionRequest): string {
  const canonical = JSON.stringify([
    request.outcome,
    request.dispositionId.toLowerCase(),
    request.note ?? null,
    request.followUp === undefined ? null : new Date(request.followUp.dueAt).toISOString(),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
