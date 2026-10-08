import { z } from 'zod';

/**
 * The script graph and its translations, as data (T-0113; the contract is
 * docs/api/scripting.openapi.yaml, T-0112; D-L91, D-L93, D-L96).
 *
 * SHAPE is checked here, on every save (400). Whether a graph is COMPLETE
 * enough to publish is `script-publish.ts` (409 `script_invalid`). A draft
 * may be incomplete: a target that names no node yet, a cycle, a start that
 * names nothing. It may never be the wrong SHAPE: the six node kinds are a
 * closed union, and every object is closed, so nothing can ride along in the
 * jsonb that the contract does not name (D-P31: no node and no form field
 * binds to a record).
 *
 * Every failure is a Zod issue whose path the API turns into `details[].path`
 * and whose `params.reason` (or Zod code) becomes `details[].code`. Never the
 * value: wording is a programme's compliance text.
 *
 * Lengths are counted in CODE POINTS, as the contract's JSON Schema does.
 * Integers are bounded to -2^31..2^31-1 (D-L93). NUL characters and lone
 * UTF-16 surrogates are refused by `stringProblems`, which the API runs over
 * the whole body before this schema (a NUL "anywhere" is `nul_character`).
 */

/** The seven design-menu locales (DESIGN_MENU_LOCALES in @kasuwa/i18n; D-L91). */
export const SCRIPT_LOCALES = ['en', 'fr', 'pcm', 'ha', 'yo', 'ig', 'sw'] as const;
export type ScriptLocale = (typeof SCRIPT_LOCALES)[number];
export const ScriptLocaleSchema = z.enum(SCRIPT_LOCALES);

/** 256 KiB: the draft (graph and translations together), serialised, in UTF-8 bytes (D-L93). */
export const SCRIPT_MAX_SERIALISED_BYTES = 262_144;

export const INT32_MIN = -2_147_483_648;
export const INT32_MAX = 2_147_483_647;

/** Stable reason codes this module adds (`details[].code`). */
export const SCRIPT_REASON = {
  nul: 'nul_character',
  /** A lone UTF-16 surrogate: Postgres jsonb cannot hold one (R6: never a 5xx). */
  badCharacter: 'invalid_character',
  tooSmall: 'too_small',
  tooBig: 'too_big',
  duplicateId: 'duplicate_id',
  duplicateKey: 'duplicate_key',
  required: 'required',
  valueMismatch: 'invalid_value',
} as const;

const NODE_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const CONTACT_FIELD_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;

export const NodeIdSchema = z.string().regex(NODE_ID_PATTERN);
export const ChoiceKeySchema = z.string().regex(NODE_ID_PATTERN);

export function isNodeId(value: string): boolean {
  return NODE_ID_PATTERN.test(value);
}

const int32 = z.number().int().min(INT32_MIN).max(INT32_MAX);

/** Length in code points, as JSON Schema and Postgres count it. */
export function codePoints(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/**
 * Wording of `min`..`max` code points. NUL and lone surrogates are found by
 * `stringProblems` before this runs; this checks only the length.
 */
export function wording(min: number, max: number) {
  return z.string().superRefine((value, context) => {
    const length = codePoints(value);
    if (length < min) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `shorter than ${min}`,
        params: { reason: SCRIPT_REASON.tooSmall },
      });
    } else if (length > max) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `longer than ${max}`,
        params: { reason: SCRIPT_REASON.tooBig },
      });
    }
  });
}

/** A problem in some string of a body, by path; never the string itself. */
export interface StringProblem {
  path: string;
  code: string;
}

/**
 * Every string (and object key) in `value` that holds a NUL or a lone
 * surrogate, by path. Iterative, so a deeply nested body cannot exhaust the
 * stack. A bad KEY is reported at its parent's path, so the key is never
 * echoed. Paths are joined with `.`, as the API's details are.
 */
export function stringProblems(value: unknown, root = ''): StringProblem[] {
  const problems: StringProblem[] = [];
  const stack: { value: unknown; path: string }[] = [{ value, path: root }];
  const join = (base: string, key: string) => (base === '' ? key : `${base}.${key}`);
  const judge = (text: string): string | null => {
    if (text.includes('\u0000')) return SCRIPT_REASON.nul;
    if (hasLoneSurrogate(text)) return SCRIPT_REASON.badCharacter;
    return null;
  };
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    const current = item.value;
    if (typeof current === 'string') {
      const code = judge(current);
      if (code !== null) problems.push({ path: item.path, code });
    } else if (Array.isArray(current)) {
      current.forEach((child, index) => {
        stack.push({ value: child, path: join(item.path, String(index)) });
      });
    } else if (typeof current === 'object' && current !== null) {
      for (const [key, child] of Object.entries(current)) {
        const keyCode = judge(key);
        if (keyCode !== null) {
          problems.push({ path: item.path, code: keyCode });
          continue;
        }
        stack.push({ value: child, path: join(item.path, key) });
      }
    }
  }
  return problems.sort((left, right) => (left.path < right.path ? -1 : 1));
}

/** True for a high surrogate not followed by a low one, or a low one on its own. */
export function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

// --- nodes ---------------------------------------------------------------------

const CanvasPosition = z
  .object({
    x: z.number().int().min(0).max(100_000),
    y: z.number().int().min(0).max(100_000),
  })
  .strict();

const Title = wording(1, 120);
const Text = wording(1, 4000);
const Label = wording(1, 120);

const SayNode = z
  .object({
    id: NodeIdSchema,
    type: z.literal('say'),
    title: Title,
    text: Text,
    next: NodeIdSchema,
    position: CanvasPosition.optional(),
  })
  .strict();

const QuestionChoice = z
  .object({ key: ChoiceKeySchema, label: Label, next: NodeIdSchema })
  .strict();

const QuestionNode = z
  .object({
    id: NodeIdSchema,
    type: z.literal('question'),
    title: Title,
    text: Text,
    hint: wording(0, 500).nullable().optional(),
    choices: z.array(QuestionChoice).min(2).max(12),
    position: CanvasPosition.optional(),
  })
  .strict();

const FIELD_TYPES = ['text', 'number', 'money', 'date', 'choice'] as const;

const FormFieldOption = z.object({ key: ChoiceKeySchema, label: Label }).strict();

const MINOR_UNITS = /^[0-9]{1,18}$/;

const FormField = z
  .object({
    key: ChoiceKeySchema,
    label: Label,
    type: z.enum(FIELD_TYPES),
    required: z.boolean(),
    maxLength: z.number().int().min(1).max(2000).optional(),
    minimum: int32.optional(),
    maximum: int32.optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    minimumMinor: z.string().regex(MINOR_UNITS).optional(),
    maximumMinor: z.string().regex(MINOR_UNITS).optional(),
    minDaysAhead: z.number().int().min(0).max(366).optional(),
    maxDaysAhead: z.number().int().min(0).max(366).optional(),
    options: z.array(FormFieldOption).min(1).max(30).optional(),
  })
  .strict()
  .superRefine((field, context) => {
    const require = (key: keyof typeof field) => {
      if (field[key] === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'required for this field type',
          params: { reason: SCRIPT_REASON.required },
        });
      }
    };
    // FormField: "all three required" for money; "options ... (required)" for choice.
    if (field.type === 'money') {
      require('currency');
      require('minimumMinor');
      require('maximumMinor');
    }
    if (field.type === 'choice') require('options');
    if (field.options !== undefined) duplicateKeys(field.options, ['options'], context);
  });

const FormNode = z
  .object({
    id: NodeIdSchema,
    type: z.literal('form'),
    title: Title,
    text: Text,
    fields: z.array(FormField).min(1).max(20),
    next: NodeIdSchema,
    position: CanvasPosition.optional(),
  })
  .strict();

const ConditionText = z.string().max(200);
const ConditionValue = z.union([
  ConditionText,
  int32,
  z.boolean(),
  z.array(ConditionText).max(20),
]);

const OPERATORS = [
  'equals',
  'not_equals',
  'one_of',
  'is_set',
  'is_not_set',
  'greater_than',
  'less_than',
] as const;
export type ConditionOperator = (typeof OPERATORS)[number];

/** `is_set` and `is_not_set` take no value; `one_of` takes a list (ConditionOperator). */
function operatorTakes(
  condition: { operator: ConditionOperator; value?: unknown },
  context: z.RefinementCtx,
): void {
  const { operator, value } = condition;
  const mismatch = () =>
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['value'],
      message: 'the value does not fit the operator',
      params: { reason: SCRIPT_REASON.valueMismatch },
    });
  if (operator === 'is_set' || operator === 'is_not_set') {
    if (value !== undefined) mismatch();
    return;
  }
  if (value === undefined) {
    mismatch();
    return;
  }
  if (operator === 'one_of' && !Array.isArray(value)) mismatch();
  if (operator !== 'one_of' && Array.isArray(value)) mismatch();
  if ((operator === 'greater_than' || operator === 'less_than') && typeof value !== 'number') {
    mismatch();
  }
}

const ContactFieldCondition = z
  .object({
    source: z.literal('contact_field'),
    field: z.string().regex(CONTACT_FIELD_PATTERN),
    operator: z.enum(OPERATORS),
    value: ConditionValue.optional(),
  })
  .strict();

const AnswerCondition = z
  .object({
    source: z.literal('answer'),
    nodeId: NodeIdSchema,
    fieldKey: ChoiceKeySchema.optional(),
    operator: z.enum(OPERATORS),
    value: ConditionValue.optional(),
  })
  .strict();

const BranchCondition = z
  .discriminatedUnion('source', [ContactFieldCondition, AnswerCondition])
  .superRefine(operatorTakes);

const BranchNode = z
  .object({
    id: NodeIdSchema,
    type: z.literal('branch'),
    title: Title,
    condition: BranchCondition,
    whenTrue: NodeIdSchema,
    whenFalse: NodeIdSchema,
    position: CanvasPosition.optional(),
  })
  .strict();

const ComplianceNode = z
  .object({
    id: NodeIdSchema,
    type: z.literal('compliance'),
    title: Title,
    text: Text,
    next: NodeIdSchema,
    position: CanvasPosition.optional(),
  })
  .strict();

const EndNode = z
  .object({
    id: NodeIdSchema,
    type: z.literal('end'),
    title: Title,
    text: wording(0, 4000).nullable().optional(),
    suggestedDispositionId: z.string().uuid().nullable().optional(),
    position: CanvasPosition.optional(),
  })
  .strict();

const ScriptNode = z.discriminatedUnion('type', [
  SayNode,
  QuestionNode,
  FormNode,
  BranchNode,
  ComplianceNode,
  EndNode,
]);

function duplicateKeys(
  items: readonly { key: string }[],
  base: (string | number)[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...base, index, 'key'],
        message: 'duplicate key',
        params: { reason: SCRIPT_REASON.duplicateKey },
      });
    }
    seen.add(item.key);
  });
}

/**
 * A script graph: a start node id and 1..200 typed nodes. Node ids are unique
 * (R5: refused on save, so a graph with two nodes of one id is never stored).
 */
export const ScriptGraphSchema = z
  .object({
    startNodeId: NodeIdSchema,
    nodes: z.array(ScriptNode).min(1).max(200),
  })
  .strict()
  .superRefine((graph, context) => {
    const seen = new Set<string>();
    graph.nodes.forEach((node, index) => {
      if (seen.has(node.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'id'],
          message: 'duplicate node id',
          params: { reason: SCRIPT_REASON.duplicateId },
        });
      }
      seen.add(node.id);
      // Choice and field keys are unique within their node: they key the
      // translations and the run's answers. (Here, not on the node schemas,
      // because a discriminated union's members must be plain objects.)
      if (node.type === 'question') {
        duplicateKeys(node.choices, ['nodes', index, 'choices'], context);
      }
      if (node.type === 'form') {
        duplicateKeys(node.fields, ['nodes', index, 'fields'], context);
      }
    });
  });

export type ScriptGraph = z.infer<typeof ScriptGraphSchema>;
export type ScriptNode = ScriptGraph['nodes'][number];
export type BranchConditionValue = z.infer<typeof BranchCondition>;

/**
 * The empty draft createScript stores when no graph is sent (0030's column
 * default). It is not a valid ScriptGraph (no nodes) and is never
 * publishable: its start names no node (`missing_start`). It cannot be SAVED
 * either: a save is held to `ScriptGraphSchema`.
 */
export const EMPTY_DRAFT_GRAPH = { startNodeId: 'start', nodes: [] } as const;

/** A graph as stored: either a ScriptGraph or the empty draft. */
export interface StoredGraph {
  startNodeId: string;
  nodes: ScriptNode[];
}

// --- translations ----------------------------------------------------------------

function maxProperties<T extends z.ZodTypeAny>(
  schema: T,
  max: number,
): z.ZodEffects<T, z.output<T>, z.input<T>> {
  return schema.superRefine((value: unknown, context) => {
    if (typeof value === 'object' && value !== null && Object.keys(value).length > max) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `more than ${max} properties`,
        params: { reason: SCRIPT_REASON.tooBig },
      });
    }
  });
}

/** A node's wording in one locale. Absent keys fall back to the source wording. */
export const NodeTranslationSchema = z
  .object({
    title: wording(1, 120).optional(),
    text: wording(1, 4000).optional(),
    hint: wording(1, 500).optional(),
    choices: maxProperties(z.record(ChoiceKeySchema, Label), 12).optional(),
    fields: maxProperties(z.record(ChoiceKeySchema, Label), 20).optional(),
  })
  .strict();
export type NodeTranslation = z.infer<typeof NodeTranslationSchema>;

/** One locale's wording, keyed by node id. */
export const TranslationTextsSchema = maxProperties(
  z.record(NodeIdSchema, NodeTranslationSchema),
  200,
);
export type TranslationTexts = Record<string, NodeTranslation>;

/** Every translation of a draft or version, keyed by locale. */
export type Translations = Partial<Record<ScriptLocale, TranslationTexts>>;

/**
 * The serialised size the cap counts: `{ graph, translations }` as JSON, in
 * UTF-8 bytes (D-L96: bytes, not UTF-16 units, so `₦` counts three).
 */
export function serialisedDraftBytes(graph: unknown, translations: unknown): number {
  return Buffer.byteLength(JSON.stringify({ graph, translations }), 'utf8');
}

// --- translations against the graph ---------------------------------------------

/** A translation key the graph does not have, by path under `base`. */
export interface TranslationMismatch {
  path: string;
  code: 'unknown_node' | 'unknown_choice' | 'unknown_field_key' | 'not_translatable';
}

/**
 * Whether `texts` (one locale) translates only what `graph` has: a node that
 * exists, a choice or field key that node has, and only the parts its kind
 * carries (a branch has no text; only a question has a hint and choices; only
 * a form has fields). Paths are `<base>.<nodeId>[.<part>[.<key>]]`.
 */
export function translationMismatches(
  graph: StoredGraph,
  texts: TranslationTexts,
  base: string,
): TranslationMismatch[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const mismatches: TranslationMismatch[] = [];
  for (const [nodeId, translation] of Object.entries(texts)) {
    const node = byId.get(nodeId);
    const at = `${base}.${nodeId}`;
    if (node === undefined) {
      mismatches.push({ path: at, code: 'unknown_node' });
      continue;
    }
    if (translation.text !== undefined && node.type === 'branch') {
      mismatches.push({ path: `${at}.text`, code: 'not_translatable' });
    }
    if (translation.hint !== undefined && node.type !== 'question') {
      mismatches.push({ path: `${at}.hint`, code: 'not_translatable' });
    }
    if (translation.choices !== undefined) {
      if (node.type !== 'question') {
        mismatches.push({ path: `${at}.choices`, code: 'not_translatable' });
      } else {
        const keys = new Set(node.choices.map((choice) => choice.key));
        for (const key of Object.keys(translation.choices)) {
          if (!keys.has(key)) mismatches.push({ path: `${at}.choices.${key}`, code: 'unknown_choice' });
        }
      }
    }
    if (translation.fields !== undefined) {
      if (node.type !== 'form') {
        mismatches.push({ path: `${at}.fields`, code: 'not_translatable' });
      } else {
        const keys = new Set(node.fields.map((field) => field.key));
        for (const key of Object.keys(translation.fields)) {
          if (!keys.has(key)) {
            mismatches.push({ path: `${at}.fields.${key}`, code: 'unknown_field_key' });
          }
        }
      }
    }
  }
  return mismatches;
}
