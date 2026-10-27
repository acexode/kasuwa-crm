import * as z from 'zod/mini';

/**
 * The typed script graph of `docs/api/scripting.openapi.yaml` (T-0112), shared
 * by the builder (T-0115) and the agent's run screen (T-0116). Shapes only:
 * no request is made here, so neither client is bound to the other.
 *
 * NOTHING HERE IS INVENTED OR PADDED. A node is parsed into exactly the
 * properties the contract names and the server sent, so a node the builder
 * never touched goes back on the wire exactly as it was served (D-L102). An
 * optional property the server left out stays out; a `null` stays `null`.
 *
 * WORDING IS PLAIN TEXT. Nothing in a node is markup, and no screen ever
 * renders it as HTML: `{contact.displayName}` becomes text, never a tag.
 */

export const SCRIPT_LOCALES = ['en', 'fr', 'pcm', 'ha', 'yo', 'ig', 'sw'] as const;
export const ScriptLocale = z.enum(SCRIPT_LOCALES);
export type ScriptLocale = z.infer<typeof ScriptLocale>;

export const NODE_TYPES = ['say', 'question', 'form', 'branch', 'compliance', 'end'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const CONDITION_OPERATORS = ['equals', 'not_equals', 'one_of', 'is_set', 'is_not_set', 'greater_than', 'less_than'] as const;
export const ConditionOperator = z.enum(CONDITION_OPERATORS);
export type ConditionOperator = z.infer<typeof ConditionOperator>;

export const FORM_FIELD_TYPES = ['text', 'number', 'money', 'date', 'choice'] as const;
export const FormFieldType = z.enum(FORM_FIELD_TYPES);
export type FormFieldType = z.infer<typeof FormFieldType>;

/** The pattern NodeId and ChoiceKey share. */
export const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

const Position = z.object({ x: z.int(), y: z.int() });
export type Position = z.infer<typeof Position>;

const Choice = z.object({ key: z.string(), label: z.string(), next: z.string() });
export type Choice = z.infer<typeof Choice>;

const FieldOption = z.object({ key: z.string(), label: z.string() });

export const FormField = z.object({
  key: z.string(),
  label: z.string(),
  type: FormFieldType,
  required: z.boolean(),
  maxLength: z.optional(z.int()),
  minimum: z.optional(z.int()),
  maximum: z.optional(z.int()),
  currency: z.optional(z.string()),
  minimumMinor: z.optional(z.string()),
  maximumMinor: z.optional(z.string()),
  minDaysAhead: z.optional(z.int()),
  maxDaysAhead: z.optional(z.int()),
  options: z.optional(z.array(FieldOption)),
});
export type FormField = z.infer<typeof FormField>;

export const ConditionValue = z.union([z.string(), z.int(), z.boolean(), z.array(z.string())]);
export type ConditionValue = z.infer<typeof ConditionValue>;

const ContactFieldCondition = z.object({
  source: z.literal('contact_field'),
  field: z.string(),
  operator: ConditionOperator,
  value: z.optional(ConditionValue),
});

const AnswerCondition = z.object({
  source: z.literal('answer'),
  nodeId: z.string(),
  fieldKey: z.optional(z.string()),
  operator: ConditionOperator,
  value: z.optional(ConditionValue),
});

export const BranchCondition = z.discriminatedUnion('source', [ContactFieldCondition, AnswerCondition]);
export type BranchCondition = z.infer<typeof BranchCondition>;

const SayNode = z.object({
  id: z.string(),
  type: z.literal('say'),
  title: z.string(),
  text: z.string(),
  next: z.string(),
  position: z.optional(Position),
});

const QuestionNode = z.object({
  id: z.string(),
  type: z.literal('question'),
  title: z.string(),
  text: z.string(),
  hint: z.optional(z.nullable(z.string())),
  choices: z.array(Choice),
  position: z.optional(Position),
});

const FormNode = z.object({
  id: z.string(),
  type: z.literal('form'),
  title: z.string(),
  text: z.string(),
  fields: z.array(FormField),
  next: z.string(),
  position: z.optional(Position),
});

const BranchNode = z.object({
  id: z.string(),
  type: z.literal('branch'),
  title: z.string(),
  condition: BranchCondition,
  whenTrue: z.string(),
  whenFalse: z.string(),
  position: z.optional(Position),
});

const ComplianceNode = z.object({
  id: z.string(),
  type: z.literal('compliance'),
  title: z.string(),
  text: z.string(),
  next: z.string(),
  position: z.optional(Position),
});

const EndNode = z.object({
  id: z.string(),
  type: z.literal('end'),
  title: z.string(),
  text: z.optional(z.nullable(z.string())),
  suggestedDispositionId: z.optional(z.nullable(z.string())),
  position: z.optional(Position),
});

export const ScriptNode = z.discriminatedUnion('type', [SayNode, QuestionNode, FormNode, BranchNode, ComplianceNode, EndNode]);
export type ScriptNode = z.infer<typeof ScriptNode>;
export type QuestionNode = z.infer<typeof QuestionNode>;
export type FormNode = z.infer<typeof FormNode>;
export type BranchNode = z.infer<typeof BranchNode>;
export type EndNode = z.infer<typeof EndNode>;

export const ScriptGraph = z.object({ startNodeId: z.string(), nodes: z.array(ScriptNode) });
export type ScriptGraph = z.infer<typeof ScriptGraph>;

export const NodeTranslation = z.object({
  title: z.optional(z.string()),
  text: z.optional(z.string()),
  hint: z.optional(z.string()),
  choices: z.optional(z.record(z.string(), z.string())),
  fields: z.optional(z.record(z.string(), z.string())),
});
export type NodeTranslation = z.infer<typeof NodeTranslation>;

export const TranslationTexts = z.record(z.string(), NodeTranslation);
export type TranslationTexts = z.infer<typeof TranslationTexts>;

export const Translations = z.record(z.string(), TranslationTexts);
export type Translations = z.infer<typeof Translations>;

export const StaffRef = z.object({ id: z.string(), displayName: z.string() });
export type StaffRef = z.infer<typeof StaffRef>;

export const VersionSummary = z.object({
  id: z.string(),
  number: z.int(),
  publishedAt: z.string(),
  publishedBy: z.nullable(StaffRef),
});
export type VersionSummary = z.infer<typeof VersionSummary>;

export const ScriptVersion = z.object({
  id: z.string(),
  scriptId: z.string(),
  number: z.int(),
  name: z.string(),
  sourceLocale: ScriptLocale,
  graph: ScriptGraph,
  translations: Translations,
  changes: z.array(z.string()),
  publishedAt: z.string(),
  publishedBy: z.nullable(StaffRef),
});
export type ScriptVersion = z.infer<typeof ScriptVersion>;

/** Nodes that carry wording an agent reads (every kind but the branch). */
export function hasText(node: ScriptNode): node is Exclude<ScriptNode, { type: 'branch' }> {
  return node.type !== 'branch';
}

export function nodeById(graph: ScriptGraph, id: string | null | undefined): ScriptNode | undefined {
  return id === null || id === undefined ? undefined : graph.nodes.find((node) => node.id === id);
}

/** The variable in `{family.name}` wording: the three families the contract allows, and nothing else. */
export const VARIABLE = /\{(contact\.[a-z][A-Za-z0-9]*|agent\.displayName|answer\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\}/g;
