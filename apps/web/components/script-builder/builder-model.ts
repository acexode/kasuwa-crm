import {
  KEY_PATTERN,
  type BranchCondition,
  type ConditionOperator,
  type ConditionValue,
  type FormField,
  type FormFieldType,
  type NodeType,
  type ScriptGraph,
  type ScriptNode,
  type TranslationTexts,
} from '../../lib/script-graph';

/**
 * The pure half of the P10/05 builder (T-0115): what changed, how a 409 is
 * rebased, what a new node looks like, how the draft differs from the latest
 * version. No React and no `'use client'`, so every rule is unit-tested
 * directly and a server component may import from here.
 *
 * ---------------------------------------------------------------------------
 * D-L102 FOR A WHOLE-GRAPH REPLACE (R5)
 *
 * updateScript replaces the whole graph, so "changed fields only" is judged at
 * the top level: `name`, `sourceLocale`, `graph`, each sent only when it
 * differs from what the server last served. Inside the graph the rebase after
 * a 409 is per node: a node this person never touched is taken exactly as the
 * re-read served it, a node only they changed keeps their version, and a node
 * both changed keeps their typed value field by field, with the field named
 * as "changed by someone else".
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The Contact wire names a branch may read (records.openapi.yaml), each
 * labelled `scripting.field.<name>`. The envelope (`id`, `programmeId`,
 * `version`, `withheldFields`) and the derived objects are not data, and
 * phone and email lists are not offered.
 */
export const BRANCH_FIELDS = [
  'status',
  'source',
  'preferredLanguage',
  'preferredChannel',
  'consentState',
  'dnd',
  'whatsappOptIn',
  'tags',
  'state',
  'lga',
  'companyName',
  'phoneNetwork',
  'displayName',
  'givenNames',
  'familyName',
] as const;

const BOOLEAN_FIELDS: readonly string[] = ['dnd', 'whatsappOptIn'];

/** The contact variables an author may insert. Every one is a Contact wire name. */
export const CONTACT_VARIABLES = ['contact.displayName', 'contact.givenNames', 'contact.familyName'] as const;
export const AGENT_VARIABLE = 'agent.displayName';

/** publishScript's `script_invalid` reasons (its description). Each is labelled `scripting.reason.<code>`. */
export const PUBLISH_REASONS = [
  'missing_start',
  'empty_script',
  'unknown_target',
  'unreachable_end',
  'cycle',
  'unknown_field',
  'unknown_variable',
  'disposition_not_live',
  'unchanged',
  'sensitive_field',
  'branch_on_withheld_field',
] as const;
export type PublishReason = (typeof PUBLISH_REASONS)[number];

/** Operators that compare nothing. */
export function takesNoValue(operator: ConditionOperator): boolean {
  return operator === 'is_set' || operator === 'is_not_set';
}

// ---------------------------------------------------------------------------
// Equality
// ---------------------------------------------------------------------------

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Key-order-insensitive equality: "did this change". */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

// ---------------------------------------------------------------------------
// What a save sends (D-L102)
// ---------------------------------------------------------------------------

export interface DraftState {
  readonly name: string;
  readonly graph: ScriptGraph;
}

export interface ChangedFields {
  name?: string;
  graph?: ScriptGraph;
}

/** The top-level fields that differ from what was last served, and nothing else. */
export function changedFields(draft: DraftState, served: DraftState): ChangedFields {
  const changed: ChangedFields = {};
  if (draft.name !== served.name) changed.name = draft.name;
  if (!sameJson(draft.graph, served.graph)) changed.graph = draft.graph;
  return changed;
}

export function hasChanges(changed: ChangedFields): boolean {
  return changed.name !== undefined || changed.graph !== undefined;
}

// ---------------------------------------------------------------------------
// The rebase after a 409
// ---------------------------------------------------------------------------

/** The name's key in `conflicts`. Not a NodeId (they start with a letter). */
export const NAME_CONFLICT = '#name';

export interface Rebased {
  readonly draft: DraftState;
  /** Node id (or NAME_CONFLICT) to the fields both people changed: kept as typed, flagged. */
  readonly conflicts: Readonly<Record<string, readonly string[]>>;
}

function mergeNode(base: ScriptNode, local: ScriptNode, fresh: ScriptNode): { node: ScriptNode; both: string[] } {
  if (local.type !== fresh.type || local.type !== base.type) {
    return { node: local, both: sameJson(fresh, base) ? [] : ['type'] };
  }
  const merged: Record<string, unknown> = {};
  const both: string[] = [];
  const b = base as unknown as Record<string, unknown>;
  const l = local as unknown as Record<string, unknown>;
  const f = fresh as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(f)])) {
    const mine = !sameJson(l[key], b[key]);
    const theirs = !sameJson(f[key], b[key]);
    const value = mine ? l[key] : f[key];
    if (mine && theirs && !sameJson(l[key], f[key])) both.push(key);
    if (value !== undefined) merged[key] = value;
  }
  return { node: merged as unknown as ScriptNode, both };
}

/**
 * `base` is what the person's edits were made against, `local` is the screen,
 * `fresh` is the re-read. The result is the fresh draft with this person's
 * edits re-applied, node by node.
 */
export function rebase(base: DraftState, local: DraftState, fresh: DraftState): Rebased {
  const conflicts: Record<string, string[]> = {};
  const baseNodes = new Map(base.graph.nodes.map((node) => [node.id, node]));
  const localNodes = new Map(local.graph.nodes.map((node) => [node.id, node]));
  const freshIds = new Set(fresh.graph.nodes.map((node) => node.id));
  const nodes: ScriptNode[] = [];

  for (const theirs of fresh.graph.nodes) {
    const was = baseNodes.get(theirs.id);
    const mine = localNodes.get(theirs.id);
    if (was === undefined) {
      // Added by the other person (or by both, with the same id: theirs wins
      // unless this person's differs, which is then a conflict on the node).
      if (mine !== undefined && !sameJson(mine, theirs)) {
        nodes.push(mine);
        conflicts[theirs.id] = ['type'];
      } else {
        nodes.push(theirs);
      }
      continue;
    }
    if (mine === undefined) {
      // Deleted here. If the other person changed it meanwhile, their change
      // is not silently thrown away: it comes back.
      if (!sameJson(theirs, was)) nodes.push(theirs);
      continue;
    }
    if (sameJson(mine, was)) {
      nodes.push(theirs);
      continue;
    }
    if (sameJson(theirs, was)) {
      nodes.push(mine);
      continue;
    }
    const { node, both } = mergeNode(was, mine, theirs);
    nodes.push(node);
    if (both.length > 0) conflicts[theirs.id] = both;
  }
  for (const mine of local.graph.nodes) {
    if (freshIds.has(mine.id)) continue;
    const was = baseNodes.get(mine.id);
    // Added here: kept. Deleted by the other person: kept only if this person changed it.
    if (was === undefined || !sameJson(mine, was)) nodes.push(mine);
  }

  const startNodeId = local.graph.startNodeId !== base.graph.startNodeId ? local.graph.startNodeId : fresh.graph.startNodeId;
  let name = fresh.name;
  if (local.name !== base.name) {
    name = local.name;
    if (fresh.name !== base.name && fresh.name !== local.name) conflicts[NAME_CONFLICT] = ['name'];
  }
  return { draft: { name, graph: { startNodeId, nodes } }, conflicts };
}

// ---------------------------------------------------------------------------
// Translations (R10): each changed locale PUT whole, every served node kept
// ---------------------------------------------------------------------------

/** Per locale, per node: the translated `text` typed. An empty string removes it. */
export type TranslationEdits = Readonly<Record<string, Readonly<Record<string, string>>>>;

export function translationBody(served: TranslationTexts | undefined, edits: Readonly<Record<string, string>> | undefined): TranslationTexts {
  const texts: Record<string, Record<string, unknown>> = JSON.parse(JSON.stringify(served ?? {})) as Record<string, Record<string, unknown>>;
  for (const [nodeId, text] of Object.entries(edits ?? {})) {
    const entry = { ...(texts[nodeId] ?? {}) };
    if (text.trim() === '') delete entry.text;
    else entry.text = text;
    if (Object.keys(entry).length === 0) delete texts[nodeId];
    else texts[nodeId] = entry;
  }
  return texts as TranslationTexts;
}

/** The locales whose whole body differs from what was served, in the order given. */
export function changedLocales(
  locales: readonly string[],
  served: Readonly<Record<string, TranslationTexts>>,
  edits: TranslationEdits,
): string[] {
  return locales.filter((locale) => edits[locale] !== undefined && !sameJson(translationBody(served[locale], edits[locale]), served[locale] ?? {}));
}

// ---------------------------------------------------------------------------
// New nodes (R6): shape-valid the moment they are added
// ---------------------------------------------------------------------------

/** The default wording a new node carries, in the screen's language. */
export interface NewNodeWords {
  readonly title: string;
  readonly text: string;
  readonly choice: string;
  readonly field: string;
  readonly option: string;
}

function freeKey(prefix: string, taken: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const key = `${prefix}_${index}`;
    if (!taken.has(key)) return key;
  }
}

export function newNodeId(graph: ScriptGraph, type: NodeType): string {
  return freeKey(type, new Set(graph.nodes.map((node) => node.id)));
}

const GAP = 130;
const COLUMN = 40;

/** Where a new node is drawn: under the lowest one. Layout only. */
export function nextPosition(graph: ScriptGraph): { x: number; y: number } {
  const lowest = graph.nodes.reduce((max, node) => Math.max(max, node.position?.y ?? 0), 0);
  return { x: COLUMN, y: graph.nodes.length === 0 ? 30 : lowest + GAP };
}

export function newField(fields: readonly FormField[], label: string): FormField {
  return { key: freeKey('field', new Set(fields.map((field) => field.key))), label, type: 'text', required: false };
}

/**
 * A node of `type`, complete enough that a save at once is never a 400: a
 * question has two choices, a form one field, a branch a condition. Targets
 * name the graph's first end node (or the node itself in an empty graph);
 * whether the result is publishable is publish's question, not this one.
 */
export function newNode(type: NodeType, graph: ScriptGraph, words: NewNodeWords): ScriptNode {
  const id = newNodeId(graph, type);
  const target = graph.nodes.find((node) => node.type === 'end')?.id ?? id;
  const position = nextPosition(graph);
  const title = words.title;
  switch (type) {
    case 'say':
      return { id, type, title, text: words.text, next: target, position };
    case 'compliance':
      return { id, type, title, text: words.text, next: target, position };
    case 'question':
      return {
        id,
        type,
        title,
        text: words.text,
        choices: [
          { key: 'choice_1', label: `${words.choice} 1`, next: target },
          { key: 'choice_2', label: `${words.choice} 2`, next: target },
        ],
        position,
      };
    case 'form':
      return { id, type, title, text: words.text, fields: [newField([], words.field)], next: target, position };
    case 'branch':
      return { id, type, title, condition: { source: 'contact_field', field: 'status', operator: 'is_set' }, whenTrue: target, whenFalse: target, position };
    case 'end':
      return { id, type, title, text: null, suggestedDispositionId: null, position };
  }
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export function withNode(graph: ScriptGraph, id: string, change: (node: ScriptNode) => ScriptNode): ScriptGraph {
  return { ...graph, nodes: graph.nodes.map((node) => (node.id === id ? change(node) : node)) };
}

/** A property set to a value, or removed when the value is `undefined`. */
export function withProperty<T extends object>(target: T, key: string, value: unknown): T {
  const next: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as T;
}

/** Inserts a variable token at the caret, spaced from the word before it. */
export function insertToken(text: string, caret: number | null, token: string): { text: string; caret: number } {
  const at = caret === null || caret < 0 || caret > text.length ? text.length : caret;
  const before = text.slice(0, at);
  const pad = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const inserted = `${pad}${token}`;
  return { text: `${before}${inserted}${text.slice(at)}`, caret: at + inserted.length };
}

/** A type change keeps the key, label and required flag, and the bounds the new type needs. */
export function retypeField(field: FormField, type: FormFieldType, currency: string, option: string): FormField {
  const base: FormField = { key: field.key, label: field.label, type, required: field.required };
  switch (type) {
    case 'money':
      return { ...base, currency: field.currency ?? currency, minimumMinor: field.minimumMinor ?? '0', maximumMinor: field.maximumMinor ?? '999999999999999999' };
    case 'choice':
      return { ...base, options: field.options ?? [{ key: 'option_1', label: option }] };
    case 'text':
      return field.maxLength === undefined ? base : { ...base, maxLength: field.maxLength };
    case 'number':
    case 'date':
      return base;
  }
}

/** The currency a new money field takes: the one the script already uses, or the naira (Nigeria first). */
export function scriptCurrency(graph: ScriptGraph): string {
  for (const node of graph.nodes) {
    if (node.type !== 'form') continue;
    const money = node.fields.find((field) => field.type === 'money' && field.currency !== undefined);
    if (money?.currency !== undefined) return money.currency;
  }
  return 'NGN';
}

/** Nodes an answer condition can read: the questions and forms in the graph. */
export function askableNodes(graph: ScriptGraph): ScriptNode[] {
  return graph.nodes.filter((node) => node.type === 'question' || node.type === 'form');
}

export function conditionForSource(source: 'contact_field' | 'answer', current: BranchCondition, graph: ScriptGraph): BranchCondition {
  if (source === current.source) return current;
  if (source === 'contact_field') return { source, field: 'status', operator: 'is_set' };
  const first = askableNodes(graph)[0];
  if (first === undefined) return current;
  if (first.type === 'question') {
    const choice = first.choices[0]?.key;
    return choice === undefined ? { source, nodeId: first.id, operator: 'is_set' } : { source, nodeId: first.id, operator: 'equals', value: choice };
  }
  const field = first.type === 'form' ? first.fields[0]?.key : undefined;
  return field === undefined ? { source, nodeId: first.id, operator: 'is_set' } : { source, nodeId: first.id, fieldKey: field, operator: 'is_set' };
}

/** A new operator, with the value carried over in the shape it takes (none, one, or a list). */
export function withOperator(condition: BranchCondition, operator: ConditionOperator): BranchCondition {
  const value = condition.value;
  if (takesNoValue(operator)) return withProperty({ ...condition, operator }, 'value', undefined);
  if (operator === 'one_of') {
    const list = Array.isArray(value) ? value : value === undefined ? [] : [String(value)];
    return { ...condition, operator, value: list };
  }
  const single = Array.isArray(value) ? value[0] : value;
  return withProperty({ ...condition, operator }, 'value', single ?? '');
}

/** What the value box shows for a condition's value. */
export function valueText(value: ConditionValue | undefined): string {
  if (value === undefined) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/** The typed value box, read as the value the operator and field take. */
export function parseValue(condition: BranchCondition, raw: string): ConditionValue | undefined {
  if (takesNoValue(condition.operator)) return undefined;
  if (condition.operator === 'one_of') {
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
  }
  const trimmed = raw.trim();
  if (condition.source === 'contact_field' && BOOLEAN_FIELDS.includes(condition.field) && (trimmed === 'true' || trimmed === 'false')) {
    return trimmed === 'true';
  }
  if ((condition.operator === 'greater_than' || condition.operator === 'less_than') && /^-?\d{1,9}$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

export function isBooleanField(field: string): boolean {
  return BOOLEAN_FIELDS.includes(field);
}

// ---------------------------------------------------------------------------
// Variables an author may insert (the contract's three families)
// ---------------------------------------------------------------------------

export type VariableOption =
  | { readonly variable: string; readonly kind: 'contact' | 'agent' }
  | { readonly variable: string; readonly kind: 'answer'; readonly nodeTitle: string; readonly fieldLabel: string };

export function variablesFor(graph: ScriptGraph): VariableOption[] {
  const answers: VariableOption[] = [];
  for (const node of graph.nodes) {
    if (node.type !== 'form' || !KEY_PATTERN.test(node.id)) continue;
    for (const field of node.fields) {
      if (!KEY_PATTERN.test(field.key)) continue;
      answers.push({ variable: `answer.${node.id}.${field.key}`, kind: 'answer', nodeTitle: node.title, fieldLabel: field.label });
    }
  }
  return [
    ...CONTACT_VARIABLES.map((variable) => ({ variable, kind: 'contact' as const })),
    { variable: AGENT_VARIABLE, kind: 'agent' as const },
    ...answers,
  ];
}

// ---------------------------------------------------------------------------
// The compliance diff (R8): the draft against the latest version, by node
// ---------------------------------------------------------------------------

export interface ComplianceDiff {
  readonly added: readonly ScriptNode[];
  readonly changed: readonly ScriptNode[];
  readonly removed: readonly ScriptNode[];
}

export function complianceDiff(draft: ScriptGraph, published: ScriptGraph): ComplianceDiff {
  const compliance = (graph: ScriptGraph) => graph.nodes.filter((node) => node.type === 'compliance');
  const before = new Map(compliance(published).map((node) => [node.id, node]));
  const now = compliance(draft);
  const nowIds = new Set(now.map((node) => node.id));
  const added: ScriptNode[] = [];
  const changed: ScriptNode[] = [];
  for (const node of now) {
    const was = before.get(node.id);
    if (was === undefined) added.push(node);
    else if (was.title !== node.title || (was.type === 'compliance' && node.type === 'compliance' && was.text !== node.text)) changed.push(node);
  }
  const removed = [...before.values()].filter((node) => !nowIds.has(node.id));
  return { added, changed, removed };
}

export function isEmptyDiff(diff: ComplianceDiff): boolean {
  return diff.added.length + diff.changed.length + diff.removed.length === 0;
}

// ---------------------------------------------------------------------------
// A refused publish (409 script_invalid): reasons in words, nodes by title
// ---------------------------------------------------------------------------

export interface PublishProblem {
  readonly nodeId: string | null;
  readonly reason: PublishReason | null;
}

export function publishProblems(details: readonly { readonly path: string; readonly code: string }[]): PublishProblem[] {
  const seen = new Set<string>();
  const problems: PublishProblem[] = [];
  for (const detail of details) {
    const nodeId = /^nodes\.([a-z][a-z0-9_]{0,39})(?:\.|$)/.exec(detail.path)?.[1] ?? null;
    const reason = (PUBLISH_REASONS as readonly string[]).includes(detail.code) ? (detail.code as PublishReason) : null;
    const key = `${nodeId ?? ''}|${reason ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push({ nodeId, reason });
  }
  return problems;
}

/** Where every node is drawn on the canvas: its own position, or a column for one with none. */
export function layout(graph: ScriptGraph): Map<string, { x: number; y: number }> {
  const placed = new Map<string, { x: number; y: number }>();
  let next = graph.nodes.reduce((max, node) => Math.max(max, node.position?.y ?? 0), 0) + GAP;
  for (const node of graph.nodes) {
    if (node.position !== undefined) {
      placed.set(node.id, node.position);
    } else {
      placed.set(node.id, { x: COLUMN, y: next });
      next += GAP;
    }
  }
  return placed;
}

/** The nodes a node leads to, for the canvas's edges. */
export function targetsOf(node: ScriptNode): string[] {
  switch (node.type) {
    case 'say':
    case 'form':
    case 'compliance':
      return [node.next];
    case 'question':
      return node.choices.map((choice) => choice.next);
    case 'branch':
      return [node.whenTrue, node.whenFalse];
    case 'end':
      return [];
  }
}
