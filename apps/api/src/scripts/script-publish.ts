import type {
  NodeTranslation,
  ScriptLocale,
  ScriptNode,
  StoredGraph,
  Translations,
} from './script-graph';
import { SCRIPT_LOCALES, translationMismatches } from './script-graph';

/**
 * Whether a draft is complete enough to publish (T-0113; publishScript in
 * docs/api/scripting.openapi.yaml; D-L91, D-L93, D-L96). Pure: the caller
 * loads the contact fields and the live dispositions; this decides.
 *
 * Every problem is a `{ path, code }` detail of `409 script_invalid`, naming
 * node ids, choice and field keys and reason codes, NEVER wording. Paths are
 * id-based, as the contract's example: `nodes.<id>.next`,
 * `nodes.<id>.choices.<key>.next`, `nodes.<id>.whenFalse`,
 * `translations.<locale>.<id>.text`.
 *
 * LINEAR TIME. Reachability, "every node reaches an end" and the cycle check
 * are each one pass over the nodes and edges (a BFS forward from the start, a
 * BFS backward from the ends, and an iterative three-colour DFS). Nothing
 * enumerates paths: 26 diamonds in a row are 79 nodes and 2^26 paths, and
 * publish answers in milliseconds.
 *
 * VARIABLES are `{contact.<wire name>}`, `{agent.displayName}` and
 * `{answer.<form node id>.<field key>}` and nothing else (`loan.*` waits,
 * D-L88). They are looked for in every piece of wording, source and every
 * translation alike (R2): a Hausa compliance line may not carry a field the
 * English one could not.
 *
 * FIELDS (D-L93): a branch or a variable on a contact field that is not a
 * Contact wire name is `unknown_field` (a branch) or `unknown_variable` (a
 * variable); one on a field classified `sensitive` is `sensitive_field`
 * (until D-L13); one on a field any `script.run` set cannot read is
 * `branch_on_withheld_field`. Lookups are Map-based, never on a plain object,
 * so `constructor` and `toString` are unknown like any other name.
 */

export interface PublishDetail {
  path: string;
  code: string;
}

/** What the database says about one contact field a script may read. */
export interface ScriptContactField {
  /** `field_def.classification` is `sensitive`. */
  sensitive: boolean;
  /** Some `script.run` set has `none` on it (R1: whether or not anyone holds the set). */
  withheld: boolean;
}

export interface PublishContext {
  /** Contact wire name -> its flags. A name not in the map is not a contact field. */
  contactFields: ReadonlyMap<string, ScriptContactField>;
  /** Dispositions live in the script's programme (active, not deleted), lower-cased ids. */
  liveDispositionIds: ReadonlySet<string>;
}

/** Every outgoing edge of a node, with the id-based path the contract names. */
export function edgesOf(node: ScriptNode): { target: string; path: string }[] {
  const at = `nodes.${node.id}`;
  switch (node.type) {
    case 'say':
    case 'form':
    case 'compliance':
      return [{ target: node.next, path: `${at}.next` }];
    case 'question':
      return node.choices.map((choice) => ({
        target: choice.next,
        path: `${at}.choices.${choice.key}.next`,
      }));
    case 'branch':
      return [
        { target: node.whenTrue, path: `${at}.whenTrue` },
        { target: node.whenFalse, path: `${at}.whenFalse` },
      ];
    case 'end':
      return [];
  }
}

interface Piece {
  text: string;
  path: string;
}

/** Each piece of source wording a node carries, with its path. */
function sourceWording(node: ScriptNode): Piece[] {
  const at = `nodes.${node.id}`;
  const out: Piece[] = [{ text: node.title, path: `${at}.title` }];
  if ('text' in node && typeof node.text === 'string') {
    out.push({ text: node.text, path: `${at}.text` });
  }
  if (node.type === 'question') {
    if (typeof node.hint === 'string') out.push({ text: node.hint, path: `${at}.hint` });
    for (const choice of node.choices) {
      out.push({ text: choice.label, path: `${at}.choices.${choice.key}.label` });
    }
  }
  if (node.type === 'form') {
    for (const field of node.fields) {
      out.push({ text: field.label, path: `${at}.fields.${field.key}.label` });
      for (const option of field.options ?? []) {
        out.push({ text: option.label, path: `${at}.fields.${field.key}.options.${option.key}` });
      }
    }
  }
  return out;
}

/** Each piece of translated wording, with its path. */
function translatedWording(locale: string, nodeId: string, translation: NodeTranslation): Piece[] {
  const at = `translations.${locale}.${nodeId}`;
  const out: Piece[] = [];
  if (translation.title !== undefined) out.push({ text: translation.title, path: `${at}.title` });
  if (translation.text !== undefined) out.push({ text: translation.text, path: `${at}.text` });
  if (translation.hint !== undefined) out.push({ text: translation.hint, path: `${at}.hint` });
  const choices: Record<string, string> = translation.choices ?? {};
  const fields: Record<string, string> = translation.fields ?? {};
  for (const [key, label] of Object.entries(choices)) {
    out.push({ text: label, path: `${at}.choices.${key}` });
  }
  for (const [key, label] of Object.entries(fields)) {
    out.push({ text: label, path: `${at}.fields.${key}` });
  }
  return out;
}

const VARIABLE = /\{([^{}]*)\}/g;

/** The `{...}` tokens in a piece of wording, without the braces. */
export function variablesIn(text: string): string[] {
  return [...text.matchAll(VARIABLE)].map((match) => match[1] ?? '');
}

/** Form node id -> its field keys, for `{answer.<node>.<field>}`. */
function formFields(graph: StoredGraph): Map<string, Set<string>> {
  const forms = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    if (node.type === 'form') forms.set(node.id, new Set(node.fields.map((field) => field.key)));
  }
  return forms;
}

/** The detail codes a contact field earns, or [] when it may be read. */
function fieldCodes(
  field: ScriptContactField | undefined,
  unknownCode: 'unknown_field' | 'unknown_variable',
): string[] {
  if (field === undefined) return [unknownCode];
  const codes: string[] = [];
  if (field.sensitive) codes.push('sensitive_field');
  if (field.withheld) codes.push('branch_on_withheld_field');
  return codes;
}

/** The problems with one variable token, as detail codes. */
function variableCodes(
  token: string,
  context: PublishContext,
  forms: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  if (token === 'agent.displayName') return [];
  const parts = token.split('.');
  if (parts.length === 2 && parts[0] === 'contact') {
    return fieldCodes(context.contactFields.get(parts[1] ?? ''), 'unknown_variable');
  }
  if (parts.length === 3 && parts[0] === 'answer') {
    const fields = forms.get(parts[1] ?? '');
    return fields !== undefined && fields.has(parts[2] ?? '') ? [] : ['unknown_variable'];
  }
  return ['unknown_variable'];
}

/**
 * Every node reachable from the start over known edges (BFS), and every node
 * that can reach an `end` (BFS over the reversed edges). O(nodes + edges).
 */
function reachability(graph: StoredGraph, byId: ReadonlyMap<string, ScriptNode>) {
  const forward = new Set<string>();
  if (byId.has(graph.startNodeId)) {
    const queue = [graph.startNodeId];
    forward.add(graph.startNodeId);
    for (let head = 0; head < queue.length; head += 1) {
      const node = byId.get(queue[head] ?? '');
      if (node === undefined) continue;
      for (const { target } of edgesOf(node)) {
        if (byId.has(target) && !forward.has(target)) {
          forward.add(target);
          queue.push(target);
        }
      }
    }
  }

  const reverse = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const { target } of edgesOf(node)) {
      if (!byId.has(target)) continue;
      const sources = reverse.get(target) ?? [];
      sources.push(node.id);
      reverse.set(target, sources);
    }
  }
  const reachesEnd = new Set<string>();
  const queue = graph.nodes.filter((node) => node.type === 'end').map((node) => node.id);
  for (const id of queue) reachesEnd.add(id);
  for (let head = 0; head < queue.length; head += 1) {
    for (const source of reverse.get(queue[head] ?? '') ?? []) {
      if (!reachesEnd.has(source)) {
        reachesEnd.add(source);
        queue.push(source);
      }
    }
  }
  return { forward, reachesEnd };
}

/**
 * The targets of back edges: nodes a path returns to. An iterative
 * three-colour DFS over every node, so an unreachable loop is a cycle too.
 * O(nodes + edges).
 */
function cycleTargets(graph: StoredGraph, byId: ReadonlyMap<string, ScriptNode>): Set<string> {
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const targets = new Set<string>();
  for (const root of graph.nodes) {
    if (colour.has(root.id)) continue;
    const stack: { id: string; edges: string[]; next: number }[] = [];
    const push = (id: string) => {
      const node = byId.get(id);
      colour.set(id, GREY);
      stack.push({
        id,
        edges: node === undefined ? [] : edgesOf(node).map((edge) => edge.target),
        next: 0,
      });
    };
    push(root.id);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      if (frame.next >= frame.edges.length) {
        colour.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const target = frame.edges[frame.next] ?? '';
      frame.next += 1;
      if (!byId.has(target)) continue;
      const seen = colour.get(target);
      if (seen === GREY) targets.add(target);
      else if (seen === undefined) push(target);
    }
  }
  return targets;
}

/**
 * The 409 details for publishing `graph` with `translations`, or [] when it
 * may be published. Does not judge `unchanged` (the caller compares with the
 * latest version). The graph has passed `ScriptGraphSchema` or is the empty
 * draft.
 */
export function publishProblems(
  graph: StoredGraph,
  translations: Translations,
  context: PublishContext,
): PublishDetail[] {
  const details: PublishDetail[] = [];
  const seen = new Set<string>();
  const add = (path: string, code: string) => {
    const key = `${path} ${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    details.push({ path, code });
  };

  const byId = new Map<string, ScriptNode>();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) add(`nodes.${node.id}`, 'duplicate_id');
    else byId.set(node.id, node);
  }

  const hasStart = byId.has(graph.startNodeId);
  if (!hasStart) add('startNodeId', 'missing_start');
  // Nothing for an agent to read or ask: only end nodes. This is the empty
  // draft createScript makes without a graph (EMPTY_DRAFT_GRAPH), which is a
  // valid graph and must never be published (the T-0113 suite).
  if (graph.nodes.every((node) => node.type === 'end')) add('nodes', 'empty_script');

  for (const node of graph.nodes) {
    for (const { target, path } of edgesOf(node)) {
      if (!byId.has(target)) add(path, 'unknown_target');
    }
  }

  const { forward, reachesEnd } = reachability(graph, byId);
  for (const node of graph.nodes) {
    if (hasStart && !forward.has(node.id)) add(`nodes.${node.id}`, 'unreachable_node');
    if (!reachesEnd.has(node.id)) add(`nodes.${node.id}`, 'unreachable_end');
  }
  for (const id of cycleTargets(graph, byId)) add(`nodes.${id}`, 'cycle');

  // Branches on contact fields and on answers.
  const forms = formFields(graph);
  for (const node of graph.nodes) {
    if (node.type !== 'branch') continue;
    const at = `nodes.${node.id}.condition`;
    const { condition } = node;
    if (condition.source === 'contact_field') {
      for (const code of fieldCodes(context.contactFields.get(condition.field), 'unknown_field')) {
        add(`${at}.field`, code);
      }
    } else {
      const target = byId.get(condition.nodeId);
      const valid =
        target !== undefined &&
        (condition.fieldKey === undefined
          ? target.type === 'question'
          : target.type === 'form' && (forms.get(target.id)?.has(condition.fieldKey) ?? false));
      if (!valid) add(`${at}.nodeId`, 'unknown_variable');
    }
  }

  // Variables, in the source wording and in every translation (R2).
  const judge = (pieces: Piece[]) => {
    for (const { text, path } of pieces) {
      for (const token of variablesIn(text)) {
        for (const code of variableCodes(token, context, forms)) add(path, code);
      }
    }
  };
  for (const node of graph.nodes) judge(sourceWording(node));
  for (const locale of SCRIPT_LOCALES) {
    const texts = translations[locale];
    if (texts === undefined) continue;
    // A translation of a node, choice or field the draft no longer has.
    for (const mismatch of translationMismatches(graph, texts, `translations.${locale}`)) {
      add(mismatch.path, mismatch.code);
    }
    for (const [nodeId, translation] of Object.entries(texts)) {
      judge(translatedWording(locale, nodeId, translation));
    }
  }

  // A suggested disposition must be live in the script's programme. Unknown,
  // another programme's or tenant's, deactivated and deleted are ONE code.
  for (const node of graph.nodes) {
    if (node.type !== 'end') continue;
    const id = node.suggestedDispositionId;
    if (typeof id === 'string' && !context.liveDispositionIds.has(id.toLowerCase())) {
      add(`nodes.${node.id}.suggestedDispositionId`, 'disposition_not_live');
    }
  }

  return details;
}

/** The suggested disposition ids a draft names, lower-cased. */
export function suggestedDispositionIds(graph: StoredGraph): string[] {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type === 'end' && typeof node.suggestedDispositionId === 'string') {
      ids.add(node.suggestedDispositionId.toLowerCase());
    }
  }
  return [...ids];
}

// --- the publish audit (x-kasuwa-audit-names) -------------------------------------

/** A JSON value with object keys sorted, so key order never reads as a change. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Each compliance node's content in every locale, for comparing two versions. */
function complianceContent(graph: StoredGraph, translations: Translations): Map<string, string> {
  const content = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.type !== 'compliance') continue;
    const localised: Record<string, unknown> = {};
    for (const locale of SCRIPT_LOCALES) {
      const translation = translations[locale as ScriptLocale]?.[node.id];
      if (translation !== undefined) localised[locale] = canonical(translation);
    }
    // Its wording, title and where it leads, and every translation of them (R3).
    content.set(
      node.id,
      JSON.stringify({ title: node.title, text: node.text, next: node.next, localised }),
    );
  }
  return content;
}

export interface ComplianceDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * The compliance nodes added, removed and changed between the previous
 * version (null for the first publish) and this one: node ids only, sorted.
 * A node whose wording changed in ANY locale is changed (R3); one that did
 * not change is in no list.
 */
export function complianceDiff(
  previous: { graph: StoredGraph; translations: Translations } | null,
  next: { graph: StoredGraph; translations: Translations },
): ComplianceDiff {
  const before =
    previous === null
      ? new Map<string, string>()
      : complianceContent(previous.graph, previous.translations);
  const after = complianceContent(next.graph, next.translations);
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed = [...after.keys()]
    .filter((id) => before.has(id) && before.get(id) !== after.get(id))
    .sort();
  return { added, removed, changed };
}
