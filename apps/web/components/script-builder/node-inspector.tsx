'use client';

import { useId, useRef, type ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { TypePill } from '../script-shared/node-style';
import {
  CONDITION_OPERATORS,
  FORM_FIELD_TYPES,
  nodeById,
  type BranchCondition,
  type ConditionOperator,
  type FormField,
  type FormFieldType,
  type ScriptGraph,
  type ScriptNode,
} from '../../lib/script-graph';
import type { AuthorDisposition } from '../../lib/scripting-api';
import {
  BRANCH_FIELDS,
  askableNodes,
  conditionForSource,
  insertToken,
  isBooleanField,
  newField,
  parseValue,
  retypeField,
  scriptCurrency,
  takesNoValue,
  valueText,
  variablesFor,
  withOperator,
  withProperty,
} from './builder-model';

/**
 * The selected node's editor (P10/05). Every route is CHOSEN from the graph,
 * every branch condition from the contract's Contact field references and
 * operators: nothing that steers a run is typed as free text. A form's fields
 * collect answers on the run only and bind to no record (D-P31). Read-only
 * while a published version is shown: a version is immutable.
 */

/** The export's inspector controls: 40px, radius 8, a border-strong edge, 14px text. */
const INPUT =
  'h-control-md w-full min-w-0 rounded-md border border-border-strong bg-surface px-2.5 text-body-sm text-text placeholder:text-text-muted is-hover:border-text-2 is-focus:field-focus read-only:bg-surface-sunken disabled:cursor-not-allowed disabled:border-border disabled:bg-disabled-bg disabled:text-disabled-text';
const TEXTAREA =
  'w-full min-w-0 resize-y rounded-md border border-border-strong bg-surface p-2.5 text-body-sm leading-[21px] text-text placeholder:text-text-muted is-hover:border-text-2 is-focus:field-focus read-only:bg-surface-sunken';
const LABEL = 'flex min-w-0 flex-col gap-1.5 text-caption font-bold text-text-2';
/** A quiet text action inside the inspector (add an answer, add a field). */
const QUIET =
  'inline-flex min-h-touch items-center gap-1 self-start rounded-md px-1 text-meta font-bold text-primary-text is-hover:bg-primary-soft is-focus-visible:ring-focus md:min-h-0 md:py-1';
/** A 32px icon button in the inspector's header (the export's delete). */
const ICON_BUTTON = 'flex size-8 shrink-0 items-center justify-center rounded-6 is-hover:bg-surface-sunken is-focus-visible:ring-focus';

export interface InspectorProps {
  readonly t: Translator;
  readonly graph: ScriptGraph;
  readonly node: ScriptNode;
  /** The source language's name, for "Line · English". */
  readonly language: string;
  readonly isStart: boolean;
  readonly readOnly: boolean;
  readonly dispositions: readonly AuthorDisposition[];
  readonly conflicts: readonly string[];
  readonly onChange: (node: ScriptNode) => void;
  readonly onRemove: () => void;
  readonly onStart: () => void;
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={LABEL}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

/** A select of the graph's nodes, by title. A target that names no node yet reads "not set". */
function TargetSelect({
  t,
  graph,
  self,
  value,
  name,
  disabled,
  onChange,
  label,
  id,
}: {
  t: Translator;
  graph: ScriptGraph;
  self: string;
  value: string;
  name: string;
  disabled: boolean;
  onChange: (value: string) => void;
  /** Its accessible name, when no <label> names it. */
  label?: string;
  id?: string;
}) {
  const known = graph.nodes.some((node) => node.id === value);
  return (
    <select
      id={id}
      data-field-input={name}
      aria-label={id === undefined ? label : undefined}
      value={known ? value : ''}
      disabled={disabled}
      onChange={(event) => {
        if (event.target.value !== '') onChange(event.target.value);
      }}
      className={INPUT}
    >
      {known ? null : <option value="">{t.t('scripting.builder.target.none')}</option>}
      {graph.nodes
        .filter((node) => node.id !== self)
        .map((node) => (
          <option key={node.id} value={node.id} data-script-text="">
            {node.title}
          </option>
        ))}
    </select>
  );
}

export function NodeInspector({ t, graph, node, language, isStart, readOnly, dispositions, conflicts, onChange, onRemove, onStart }: InspectorProps) {
  const text = useRef<HTMLTextAreaElement | null>(null);
  const set = (key: string, value: unknown) => onChange(withProperty(node, key, value));

  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      <div className="flex items-center gap-2">
        <TypePill t={t} type={node.type} />
        {isStart ? <span className="text-caption font-normal text-text-muted">{t.t('scripting.builder.startNode')}</span> : null}
        <span className="flex-1" />
        <code className="font-mono text-micro font-normal text-text-muted">{node.id}</code>
        {readOnly ? null : (
          <>
            {isStart ? null : (
              <button type="button" onClick={onStart} aria-label={t.t('scripting.builder.makeStart')} title={t.t('scripting.builder.makeStart')} className={`${ICON_BUTTON} text-text-2`}>
                <Icon name="vertical_align_top" size={18} />
              </button>
            )}
            <button type="button" onClick={onRemove} aria-label={t.t('scripting.builder.remove')} title={t.t('scripting.builder.remove')} className={`${ICON_BUTTON} text-danger-text`}>
              <Icon name="delete" size={18} />
            </button>
          </>
        )}
      </div>

      {conflicts.length > 0 ? (
        <p data-testid="changed-elsewhere" role="note" className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2.5 text-meta text-warning-text">
          <Icon name="warning" size={18} />
          {t.t('scripting.builder.changedElsewhere')}
        </p>
      ) : null}

      <Field label={t.t('scripting.builder.field.name')}>
        {(id) => (
          <input id={id} data-field-input="title" value={node.title} maxLength={120} readOnly={readOnly} onChange={(event) => set('title', event.target.value)} className={INPUT} />
        )}
      </Field>

      {node.type === 'branch' ? null : (
        <Field label={t.t('scripting.builder.field.line', { language })}>
          {(id) => (
            <textarea
              id={id}
              ref={text}
              data-field-input="text"
              rows={5}
              maxLength={4000}
              value={node.text ?? ''}
              readOnly={readOnly}
              onChange={(event) => set('text', node.type === 'end' && event.target.value === '' ? null : event.target.value)}
              placeholder={t.t('scripting.builder.linePlaceholder')}
              className={TEXTAREA}
            />
          )}
        </Field>
      )}

      {node.type === 'branch' ? null : (
        <Variables
          t={t}
          graph={graph}
          disabled={readOnly}
          onInsert={(token) => {
            const element = text.current;
            const current = node.text ?? '';
            const next = insertToken(current, element?.selectionStart ?? null, token);
            set('text', next.text);
            requestAnimationFrame(() => {
              element?.focus();
              element?.setSelectionRange(next.caret, next.caret);
            });
          }}
        />
      )}

      <div className="flex min-w-0 flex-col gap-3 border-t border-border pt-3">
      <h3 className="text-overline text-text-muted">{t.t('scripting.builder.settings')}</h3>
      {node.type === 'question' ? (
        <Field label={t.t('scripting.builder.field.hint')}>
          {(id) => (
            <input
              id={id}
              data-field-input="hint"
              value={node.hint ?? ''}
              maxLength={500}
              readOnly={readOnly}
              onChange={(event) => set('hint', event.target.value === '' ? (node.hint === undefined ? undefined : null) : event.target.value)}
              className={INPUT}
            />
          )}
        </Field>
      ) : null}

      {node.type === 'say' || node.type === 'form' || node.type === 'compliance' ? (
        <Field label={t.t('scripting.builder.field.next')}>
          {(id) => (
              <TargetSelect
                id={id}
                t={t}
                graph={graph}
                self={node.id}
                value={node.next}
                name="next"
                disabled={readOnly}
                label={t.t('scripting.builder.field.next')}
                onChange={(value) => set('next', value)}
              />
          )}
        </Field>
      ) : null}

      {node.type === 'question' ? <Choices t={t} graph={graph} node={node} readOnly={readOnly} onChange={onChange} /> : null}
      {node.type === 'form' ? <FormFields t={t} graph={graph} node={node} readOnly={readOnly} onChange={onChange} /> : null}
      {node.type === 'branch' ? <Branch t={t} graph={graph} node={node} readOnly={readOnly} onChange={onChange} /> : null}

      {node.type === 'end' ? (
        <Field label={t.t('scripting.builder.field.suggested')}>
          {(id) => (
            <select
              id={id}
              data-field-input="suggestedDispositionId"
              value={node.suggestedDispositionId ?? ''}
              disabled={readOnly}
              onChange={(event) => set('suggestedDispositionId', event.target.value === '' ? null : event.target.value)}
              className={INPUT}
            >
              <option value="">{t.t('scripting.builder.suggested.none')}</option>
              {node.suggestedDispositionId !== null &&
              node.suggestedDispositionId !== undefined &&
              !dispositions.some((entry) => entry.id === node.suggestedDispositionId) ? (
                <option value={node.suggestedDispositionId}>{t.t('scripting.builder.suggested.unknown')}</option>
              ) : null}
              {dispositions.map((entry) => (
                <option key={entry.id} value={entry.id} data-record-text="">
                  {entry.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      </div>
    </div>
  );
}

function Variables({ t, graph, disabled, onInsert }: { t: Translator; graph: ScriptGraph; disabled: boolean; onInsert: (token: string) => void }) {
  const label = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p id={label} className="text-caption font-bold text-text-2">
        {t.t('scripting.builder.variables.heading')}
      </p>
      <div role="group" aria-labelledby={label} className="flex flex-wrap gap-1">
        {variablesFor(graph).map((option) => (
          <button
            key={option.variable}
            type="button"
            data-action="insert-variable"
            data-variable={option.variable}
            disabled={disabled}
            onClick={() => onInsert(`{${option.variable}}`)}
            title={option.kind === 'answer' ? `${t.t('scripting.builder.variable.answer')} ${option.fieldLabel}` : t.t(`scripting.builder.variable.${option.variable}` as MessageId)}
            className="inline-flex h-[26px] max-w-full items-center truncate rounded-[5px] border border-primary-soft-strong bg-primary-soft px-[7px] font-mono text-micro font-normal text-primary-text is-hover:bg-primary-soft-strong is-focus-visible:ring-focus disabled:cursor-not-allowed disabled:border-border disabled:bg-disabled-bg disabled:text-disabled-text"
          >
            {`{${option.variable}}`}
            <span className="sr-only">
              {option.kind === 'answer' ? (
                <>
                  {t.t('scripting.builder.variable.answer')} <span data-script-text="">{option.fieldLabel}</span>
                </>
              ) : (
                t.t(`scripting.builder.variable.${option.variable}` as MessageId)
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Choices({
  t,
  graph,
  node,
  readOnly,
  onChange,
}: {
  t: Translator;
  graph: ScriptGraph;
  node: Extract<ScriptNode, { type: 'question' }>;
  readOnly: boolean;
  onChange: (node: ScriptNode) => void;
}) {
  const heading = useId();
  const setChoice = (index: number, key: 'label' | 'next', value: string) =>
    onChange({ ...node, choices: node.choices.map((choice, at) => (at === index ? { ...choice, [key]: value } : choice)) });
  const free = () => {
    const taken = new Set(node.choices.map((choice) => choice.key));
    for (let index = node.choices.length + 1; ; index += 1) if (!taken.has(`choice_${index}`)) return `choice_${index}`;
  };
  return (
    <fieldset aria-labelledby={heading} className="flex min-w-0 flex-col gap-2">
      <legend id={heading} className="mb-1.5 text-caption font-bold text-text-2">
        {t.t('scripting.builder.field.choices')}
      </legend>
      {node.choices.map((choice, index) => (
        <div key={choice.key} data-choice-row="" className="grid min-w-0 gap-2 rounded-md border border-border p-2">
          <input
            data-field-input="choice-label"
            aria-label={t.t('scripting.builder.field.choice', { number: index + 1 })}
            value={choice.label}
            maxLength={120}
            readOnly={readOnly}
            onChange={(event) => setChoice(index, 'label', event.target.value)}
            className={INPUT}
          />
          <div className="flex min-w-0 gap-1">
            <TargetSelect
              t={t}
              graph={graph}
              self={node.id}
              value={choice.next}
              name="choice-next"
              disabled={readOnly}
              label={t.t('scripting.builder.field.choiceNext', { number: index + 1 })}
              onChange={(value) => setChoice(index, 'next', value)}
            />
            {readOnly || node.choices.length <= 2 ? null : (
              <button
                type="button"
                aria-label={t.t('scripting.builder.removeChoice', { number: index + 1 })}
                onClick={() => onChange({ ...node, choices: node.choices.filter((_, at) => at !== index) })}
                className={`${ICON_BUTTON} text-text-2`}
              >
                <Icon name="close" size={18} />
              </button>
            )}
          </div>
        </div>
      ))}
      {readOnly || node.choices.length >= 12 ? null : (
        <button
          type="button"
          data-action="add-choice"
          onClick={() =>
            onChange({
              ...node,
              choices: [...node.choices, { key: free(), label: t.t('scripting.builder.newChoice'), next: node.choices[node.choices.length - 1]?.next ?? node.id }],
            })
          }
          className={QUIET}
        >
          <Icon name="add" size={18} />
          {t.t('scripting.builder.addChoice')}
        </button>
      )}
    </fieldset>
  );
}

function FormFields({
  t,
  graph,
  node,
  readOnly,
  onChange,
}: {
  t: Translator;
  graph: ScriptGraph;
  node: Extract<ScriptNode, { type: 'form' }>;
  readOnly: boolean;
  onChange: (node: ScriptNode) => void;
}) {
  const heading = useId();
  const setField = (index: number, field: FormField) => onChange({ ...node, fields: node.fields.map((entry, at) => (at === index ? field : entry)) });
  return (
    <fieldset aria-labelledby={heading} className="flex min-w-0 flex-col gap-2">
      <legend id={heading} className="mb-1.5 text-caption font-bold text-text-2">
        {t.t('scripting.builder.field.fields')}
      </legend>
      <p className="text-caption font-normal text-text-muted">{t.t('scripting.builder.form.note')}</p>
      {node.fields.map((field, index) => (
        <div key={field.key} data-form-field-row="" className="grid min-w-0 gap-2 rounded-md border border-border p-2">
          <input
            data-field-input="form-field-label"
            aria-label={t.t('scripting.builder.field.fieldLabel', { number: index + 1 })}
            value={field.label}
            maxLength={120}
            readOnly={readOnly}
            onChange={(event) => setField(index, { ...field, label: event.target.value })}
            className={INPUT}
          />
          <select
            data-field-input="form-field-type"
            aria-label={t.t('scripting.builder.field.fieldType', { number: index + 1 })}
            value={field.type}
            disabled={readOnly}
            onChange={(event) =>
              setField(index, retypeField(field, event.target.value as FormFieldType, scriptCurrency(graph), t.t('scripting.builder.newOption')))
            }
            className={INPUT}
          >
            {FORM_FIELD_TYPES.map((type) => (
              <option key={type} value={type}>
                {t.t(`scripting.builder.fieldType.${type}` as MessageId)}
              </option>
            ))}
          </select>
          <label className="flex min-h-touch items-center gap-2 text-body-sm text-text md:min-h-0">
            <input
              type="checkbox"
              data-field-input="form-field-required"
              checked={field.required}
              disabled={readOnly}
              onChange={(event) => setField(index, { ...field, required: event.target.checked })}
              className="h-5 w-5 accent-primary"
            />
            {t.t('scripting.builder.field.required')}
          </label>
          {readOnly || node.fields.length <= 1 ? null : (
            <button
              type="button"
              onClick={() => onChange({ ...node, fields: node.fields.filter((_, at) => at !== index) })}
              className={QUIET}
            >
              <Icon name="delete" size={18} />
              {t.t('scripting.builder.removeField')}
            </button>
          )}
        </div>
      ))}
      {readOnly || node.fields.length >= 20 ? null : (
        <button
          type="button"
          data-action="add-form-field"
          onClick={() => onChange({ ...node, fields: [...node.fields, newField(node.fields, t.t('scripting.builder.newField'))] })}
          className={QUIET}
        >
          <Icon name="add" size={18} />
          {t.t('scripting.builder.addField')}
        </button>
      )}
    </fieldset>
  );
}

function Branch({
  t,
  graph,
  node,
  readOnly,
  onChange,
}: {
  t: Translator;
  graph: ScriptGraph;
  node: Extract<ScriptNode, { type: 'branch' }>;
  readOnly: boolean;
  onChange: (node: ScriptNode) => void;
}) {
  const condition = node.condition;
  const setCondition = (next: BranchCondition) => onChange({ ...node, condition: next });
  const askable = askableNodes(graph);
  const read = condition.source === 'answer' ? nodeById(graph, condition.nodeId) : undefined;
  const choiceValue =
    condition.source === 'answer' &&
    read?.type === 'question' &&
    condition.fieldKey === undefined &&
    (condition.operator === 'equals' || condition.operator === 'not_equals');
  const boolValue = condition.source === 'contact_field' && isBooleanField(condition.field) && (condition.operator === 'equals' || condition.operator === 'not_equals');
  const valueKey = `${node.id}:${condition.source}:${condition.source === 'contact_field' ? condition.field : condition.nodeId}:${condition.operator}`;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Field label={t.t('scripting.builder.field.source')}>
        {(id) => (
          <select
            id={id}
            data-field-input="condition-source"
            value={condition.source}
            disabled={readOnly}
            onChange={(event) => setCondition(conditionForSource(event.target.value as 'contact_field' | 'answer', condition, graph))}
            className={INPUT}
          >
            <option value="contact_field">{t.t('scripting.builder.source.contact_field')}</option>
            <option value="answer" disabled={askable.length === 0}>
              {t.t('scripting.builder.source.answer')}
            </option>
          </select>
        )}
      </Field>

      {condition.source === 'contact_field' ? (
        <Field label={t.t('scripting.builder.field.contactField')}>
          {(id) => (
            <select
              id={id}
              data-field-input="condition-field"
              value={condition.field}
              disabled={readOnly}
              onChange={(event) => setCondition({ ...condition, field: event.target.value })}
              className={INPUT}
            >
              {BRANCH_FIELDS.map((field) => (
                <option key={field} value={field}>
                  {t.t(`scripting.field.${field}` as MessageId)}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : (
        <Field label={t.t('scripting.builder.field.answerOf')}>
          {(id) => (
            <select
              id={id}
              data-field-input="condition-node"
              value={condition.nodeId}
              disabled={readOnly}
              onChange={(event) => {
                const target = nodeById(graph, event.target.value);
                const fieldKey = target?.type === 'form' ? target.fields[0]?.key : undefined;
                setCondition(withProperty(withProperty({ ...condition, nodeId: event.target.value, operator: 'is_set' as ConditionOperator }, 'value', undefined), 'fieldKey', fieldKey));
              }}
              className={INPUT}
            >
              {askable.map((entry) => (
                <option key={entry.id} value={entry.id} data-script-text="">
                  {entry.title}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      {condition.source === 'answer' && read?.type === 'form' ? (
        <Field label={t.t('scripting.builder.field.answerField')}>
          {(id) => (
            <select
              id={id}
              data-field-input="condition-field-key"
              value={condition.fieldKey ?? ''}
              disabled={readOnly}
              onChange={(event) => setCondition({ ...condition, fieldKey: event.target.value })}
              className={INPUT}
            >
              {read.fields.map((field) => (
                <option key={field.key} value={field.key} data-script-text="">
                  {field.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}

      <Field label={t.t('scripting.builder.field.operator')}>
        {(id) => (
          <select
            id={id}
            data-field-input="condition-operator"
            value={condition.operator}
            disabled={readOnly}
            onChange={(event) => setCondition(withOperator(condition, event.target.value as ConditionOperator))}
            className={INPUT}
          >
            {CONDITION_OPERATORS.map((operator) => (
              <option key={operator} value={operator}>
                {t.t(`scripting.builder.operator.${operator}` as MessageId)}
              </option>
            ))}
          </select>
        )}
      </Field>

      {takesNoValue(condition.operator) ? null : (
        <Field label={t.t('scripting.builder.field.value')}>
          {(id) =>
            boolValue ? (
              <select
                id={id}
                data-field-input="condition-value"
                value={String(condition.value === true)}
                disabled={readOnly}
                onChange={(event) => setCondition({ ...condition, value: event.target.value === 'true' })}
                className={INPUT}
              >
                <option value="true">{t.t('scripting.builder.bool.true')}</option>
                <option value="false">{t.t('scripting.builder.bool.false')}</option>
              </select>
            ) : choiceValue && read?.type === 'question' ? (
              <select
                id={id}
                data-field-input="condition-value"
                value={typeof condition.value === 'string' ? condition.value : ''}
                disabled={readOnly}
                onChange={(event) => setCondition({ ...condition, value: event.target.value })}
                className={INPUT}
              >
                {read.choices.map((choice) => (
                  <option key={choice.key} value={choice.key} data-script-text="">
                    {choice.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                key={valueKey}
                id={id}
                data-field-input="condition-value"
                defaultValue={valueText(condition.value)}
                maxLength={condition.operator === 'one_of' ? 4000 : 200}
                readOnly={readOnly}
                onChange={(event) => setCondition(withProperty(condition, 'value', parseValue(condition, event.target.value)))}
                className={INPUT}
              />
            )
          }
        </Field>
      )}
      {condition.operator === 'one_of' ? <p className="text-caption font-normal text-text-muted">{t.t('scripting.builder.valueHint')}</p> : null}

      <Field label={t.t('scripting.builder.field.whenTrue')}>
        {(id) => (
            <TargetSelect
              id={id}
              t={t}
              graph={graph}
              self={node.id}
              value={node.whenTrue}
              name="whenTrue"
              disabled={readOnly}
              label={t.t('scripting.builder.field.whenTrue')}
              onChange={(value) => onChange({ ...node, whenTrue: value })}
            />
        )}
      </Field>
      <Field label={t.t('scripting.builder.field.whenFalse')}>
        {(id) => (
            <TargetSelect
              id={id}
              t={t}
              graph={graph}
              self={node.id}
              value={node.whenFalse}
              name="whenFalse"
              disabled={readOnly}
              label={t.t('scripting.builder.field.whenFalse')}
              onChange={(value) => onChange({ ...node, whenFalse: value })}
            />
        )}
      </Field>

      <p className="text-caption font-normal text-text-muted">{t.t('scripting.builder.branch.note')}</p>
    </div>
  );
}
