'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../../icon';
import { FIELD, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../auth/button-classes';
import type { ScreenError } from '../../../lib/admin-api';
import {
  API_NAME_MAX,
  createDirty,
  DESCRIPTION_MAX,
  LABEL_MAX,
  deriveValues,
  isClassificationRaised,
  isValidApiName,
  suggestApiName,
  updateBody,
} from '../../../lib/custom-field-model';
import {
  CLASSIFICATIONS,
  CURRENCY_CODES,
  CUSTOM_FIELD_TYPES,
  CustomFieldType as CustomFieldTypeSchema,
  createCustomField,
  currencyOf,
  picklistValuesOf,
  updateCustomField,
  type Classification,
  type CreateCustomFieldBody,
  type CustomFieldDefinition,
  type CustomFieldLimits,
  type CustomFieldObject,
  type CustomFieldType,
} from '../../../lib/custom-fields-api';
import { CLASSIFICATION_LABEL, TYPE_LABEL, errorText } from './studio-text';

/**
 * `P18/B` — the field form: create (api name, label, type, classification, and
 * the config only a picklist or a currency takes) and edit (label, description,
 * classification and picklist values only).
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FORM REFUSES BEFORE IT SENDS, AND WHAT IT LEAVES TO THE API
 *
 * It refuses what it can know is wrong — an api name outside `^[a-z][a-z0-9_]*__c$`
 * (4 to 63), an empty label, a picklist with no value, a currency field with no
 * code — marking the control `aria-invalid` and announcing the reason through
 * `aria-describedby`, so a keyboard or screen-reader user finds it where they
 * are. It does NOT check whether a name is taken: the API alone knows that,
 * retired fields included, and its answer (`409 duplicate`) is drawn by its own
 * label.
 *
 * Create sends exactly what was typed and `config` only for picklist
 * (`values`) and currency (`currencyCode`), never `{}` for the other four.
 * Edit sends only what CHANGED (the audit names what changed, by key), and
 * never the type, the api name or the currency: those are shown, locked.
 * An existing picklist value has no button: values are added or relabelled,
 * never removed or reordered.
 *
 * A refusal keeps the draft. The API's 403 is the write gate (D-L84): no read
 * says whether the caller holds `custom_field.write`, so the controls show to
 * everyone and the refusal is a translated `role="alert"`.
 * ---------------------------------------------------------------------------
 */

interface NewRow {
  readonly key: number;
  label: string;
}

type Problems = { [K in 'label' | 'apiName' | 'currency' | 'values']?: MessageId | undefined };

export type SavedKind = 'created' | 'updated';

export function FieldForm({
  t,
  mode,
  object,
  field,
  limits,
  onSaved,
  onCancel,
  onStale,
  onState,
}: {
  t: Translator;
  mode: 'create' | 'edit';
  object: CustomFieldObject;
  /** Edit mode only. */
  field?: CustomFieldDefinition;
  limits: CustomFieldLimits;
  onSaved: (kind: SavedKind) => void;
  onCancel: () => void;
  /** The field is gone or retired under us: the list must be read again. */
  onStale: () => void;
  /** What leaving would lose, and whether a write is in flight, for the screen's guards. */
  onState: (state: { dirty: boolean; saving: boolean }) => void;
}) {
  const id = useId();
  const labelRef = useRef<HTMLInputElement>(null);
  const apiNameRef = useRef<HTMLInputElement>(null);
  const currencyRef = useRef<HTMLSelectElement>(null);
  const nextKey = useRef(1);
  const inFlight = useRef(false);
  const firstValueRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const refusalRef = useRef<HTMLDivElement>(null);

  // `field` is only ever read through `editField`, so edit-mode code is narrowed to a field that exists.
  const editField = mode === 'edit' ? field : undefined;
  const editing = editField !== undefined;
  const existingValues = editField === undefined ? [] : picklistValuesOf(editField);

  const [label, setLabel] = useState(editField?.label ?? '');
  const [apiName, setApiName] = useState('');
  const [apiNameTyped, setApiNameTyped] = useState(false);
  const [type, setType] = useState<CustomFieldType>(editField?.type ?? 'text');
  const [classification, setClassification] = useState<Classification>(editField?.classification ?? 'none');
  const [description, setDescription] = useState(editField?.description ?? '');
  const [currency, setCurrency] = useState('');
  const [valueLabels, setValueLabels] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(existingValues.map((entry) => [entry.value, entry.label])),
  );
  const [rows, setRows] = useState<readonly NewRow[]>(() => (editing ? [] : [{ key: 0, label: '' }]));
  const [problems, setProblems] = useState<Problems>({});
  const [refusal, setRefusal] = useState<ScreenError | null>(null);
  const [saving, setSaving] = useState(false);

  // Focus moves into the form when it opens, so a keyboard or screen-reader user lands in it.
  useEffect(() => {
    labelRef.current?.focus();
  }, []);

  // A refusal is announced AND reached: focus moves to it, so a keyboard user
  // is not left on a control that has just been disabled or replaced.
  useEffect(() => {
    if (refusal !== null) refusalRef.current?.focus();
  }, [refusal]);

  const onLabelChange = (value: string) => {
    setLabel(value);
    setProblems((current) => ({ ...current, label: undefined }));
    // A suggestion only until the admin types in the api name box themselves.
    if (!editing && !apiNameTyped) setApiName(suggestApiName(value));
  };

  const addRow = () => {
    const key = nextKey.current;
    nextKey.current += 1;
    setRows((current) => [...current, { key, label: '' }]);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    setRefusal(null);

    const trimmed = label.trim();
    const found: Problems = {};
    if (trimmed === '') found.label = 'admin.studio.custom.label_required';
    const filled = rows.map((row) => row.label.trim()).filter((entry) => entry !== '');

    if (!editing) {
      if (!isValidApiName(apiName)) found.apiName = 'admin.studio.custom.error.invalid_api_name';
      if (type === 'currency' && currency === '') found.currency = 'admin.studio.custom.currency_required';
      if (type === 'picklist' && filled.length === 0) found.values = 'admin.studio.custom.values_required';
    }
    if (Object.keys(found).length > 0) {
      setProblems(found);
      const first = found.label
        ? labelRef.current
        : found.apiName
          ? apiNameRef.current
          : found.currency
            ? currencyRef.current
            : (firstValueRef.current ?? addRef.current);
      first?.focus();
      return;
    }
    setProblems({});

    inFlight.current = true;
    setSaving(true);
    let failure: ScreenError | null = null;
    let kind: SavedKind = 'created';

    if (editField !== undefined) {
      kind = 'updated';
      const body = updateBody(editField, { label, description, classification, valueLabels, newLabels: rows.map((row) => row.label) });
      if (Object.keys(body).length === 0) {
        // Nothing changed: there is nothing to send, and an empty update is not a valid one.
        inFlight.current = false;
        setSaving(false);
        onCancel();
        return;
      }
      const result = await updateCustomField(editField.id, body);
      if (!result.ok) failure = result.error;
    } else {
      const body: CreateCustomFieldBody = {
        objectApiName: object,
        apiName,
        label: trimmed,
        type,
        classification,
        ...(description.trim() === '' ? {} : { description: description.trim() }),
        ...(type === 'picklist'
          ? {
              config: {
                values: deriveValues(filled).map((value, index) => ({ value, label: filled[index] ?? '' })),
              },
            }
          : type === 'currency'
            ? { config: { currencyCode: currency } }
            : {}),
      };
      const result = await createCustomField(body);
      if (!result.ok) failure = result.error;
    }

    inFlight.current = false;
    setSaving(false);
    if (failure === null) {
      onSaved(kind);
      return;
    }
    // The draft stays. The reason is drawn by its own label, never by the code.
    setRefusal(failure);
    if (failure.code === 'not_found' || failure.details?.[0]?.code === 'field_retired') onStale();
  };

  const dirty =
    editField === undefined
      ? createDirty({ label, apiName, type, classification, description, currency, newLabels: rows.map((row) => row.label) })
      : Object.keys(updateBody(editField, { label, description, classification, valueLabels, newLabels: rows.map((row) => row.label) })).length > 0;
  useEffect(() => {
    onState({ dirty, saving });
  }, [dirty, saving, onState]);
  useEffect(() => () => onState({ dirty: false, saving: false }), [onState]);

  const fieldId = (name: string) => `${id}-${name}`;
  const describedBy = (name: string, problem: MessageId | undefined) =>
    problem === undefined ? fieldId(`${name}-hint`) : `${fieldId(`${name}-hint`)} ${fieldId(`${name}-error`)}`;

  const raised = editField !== undefined && isClassificationRaised(editField.classification, classification);
  const showDefaultNote = !editing && classification !== 'none';
  const picklistFull = existingValues.length + rows.length >= limits.picklistValues;
  const showValues = editField !== undefined ? editField.type === 'picklist' : type === 'picklist';

  return (
    <form
      data-testid="field-form"
      data-mode={mode}
      noValidate
      aria-labelledby={fieldId('title')}
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id={fieldId('title')} className="text-h4 font-bold">
        {t.t(editing ? 'admin.studio.custom.form.edit' : 'admin.studio.custom.form.create')}
      </h2>

      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId('label')} className="text-body-sm font-semibold">
          {t.t('admin.studio.custom.form.label')}
        </label>
        <input
          ref={labelRef}
          id={fieldId('label')}
          name="label"
          type="text"
          maxLength={LABEL_MAX}
          value={label}
          onChange={(event) => onLabelChange(event.target.value)}
          aria-invalid={problems.label === undefined ? undefined : true}
          aria-describedby={problems.label === undefined ? undefined : fieldId('label-error')}
          className={FIELD}
        />
        {problems.label === undefined ? null : (
          <p id={fieldId('label-error')} className="text-body-sm text-danger-text">
            {t.t(problems.label)}
          </p>
        )}
      </div>

      {editField !== undefined ? (
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-body-sm">
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="font-semibold text-text-2">{t.t('admin.studio.custom.form.apiName')}</dt>
            <dd data-record-text className="break-all font-mono text-mono">
              {editField.apiName}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="font-semibold text-text-2">{t.t('admin.studio.custom.form.type')}</dt>
            <dd>{t.t(TYPE_LABEL[editField.type])}</dd>
          </div>
          {currencyOf(editField) === null ? null : (
            <div className="flex flex-col gap-1">
              <dt className="font-semibold text-text-2">{t.t('admin.studio.custom.form.currency')}</dt>
              <dd>{currencyOf(editField)}</dd>
            </div>
          )}
        </dl>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={fieldId('apiName')} className="text-body-sm font-semibold">
              {t.t('admin.studio.custom.form.apiName')}
            </label>
            <input
              ref={apiNameRef}
              id={fieldId('apiName')}
              name="apiName"
              type="text"
              dir="ltr"
              maxLength={API_NAME_MAX}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={apiName}
              onChange={(event) => {
                setApiNameTyped(true);
                setApiName(event.target.value);
                setProblems((current) => ({ ...current, apiName: undefined }));
              }}
              aria-invalid={problems.apiName === undefined ? undefined : true}
              aria-describedby={describedBy('apiName', problems.apiName)}
              className={`${FIELD} font-mono`}
            />
            <p id={fieldId('apiName-hint')} className="text-body-sm text-text-muted">
              {t.t('admin.studio.custom.form.apiName.hint')}
            </p>
            {problems.apiName === undefined ? null : (
              <p id={fieldId('apiName-error')} className="text-body-sm text-danger-text">
                {t.t(problems.apiName)}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={fieldId('type')} className="text-body-sm font-semibold">
              {t.t('admin.studio.custom.form.type')}
            </label>
            <select
              id={fieldId('type')}
              name="type"
              value={type}
              onChange={(event) => {
                const parsed = CustomFieldTypeSchema.safeParse(event.target.value);
                if (parsed.success) setType(parsed.data);
              }}
              aria-describedby={fieldId('type-hint')}
              className={FIELD}
            >
              {CUSTOM_FIELD_TYPES.map((entry) => (
                <option key={entry} value={entry}>
                  {t.t(TYPE_LABEL[entry])}
                </option>
              ))}
            </select>
            <p id={fieldId('type-hint')} className="text-body-sm text-text-muted">
              {t.t('admin.studio.custom.form.type.hint')}
            </p>
          </div>

          {type === 'currency' ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={fieldId('currency')} className="text-body-sm font-semibold">
                {t.t('admin.studio.custom.form.currency')}
              </label>
              <select
                ref={currencyRef}
                id={fieldId('currency')}
                name="currencyCode"
                value={currency}
                onChange={(event) => {
                  setCurrency(event.target.value);
                  setProblems((current) => ({ ...current, currency: undefined }));
                }}
                aria-invalid={problems.currency === undefined ? undefined : true}
                aria-describedby={describedBy('currency', problems.currency)}
                className={FIELD}
              >
                <option value="">{t.t('admin.studio.custom.form.currency.choose')}</option>
                {CURRENCY_CODES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
              <p id={fieldId('currency-hint')} className="text-body-sm text-text-muted">
                {t.t('admin.studio.custom.form.currency.hint')}
              </p>
              {problems.currency === undefined ? null : (
                <p id={fieldId('currency-error')} className="text-body-sm text-danger-text">
                  {t.t(problems.currency)}
                </p>
              )}
            </div>
          ) : null}
        </>
      )}

      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="text-body-sm font-semibold">{t.t('admin.studio.custom.form.classification')}</legend>
        <div className="flex flex-wrap gap-x-4">
          {CLASSIFICATIONS.map((level) => (
            <label key={level} className="flex min-h-touch items-center gap-2 text-body-md">
              <input
                type="radio"
                name="classification"
                value={level}
                checked={classification === level}
                onChange={() => setClassification(level)}
                className="h-5 w-5 accent-primary"
              />
              {t.t(CLASSIFICATION_LABEL[level])}
            </label>
          ))}
        </div>
        {showDefaultNote ? (
          <p
            role="note"
            data-testid="classification-default-note"
            className="flex gap-2 rounded-md bg-info-soft p-3 text-body-sm text-info-text"
          >
            <Icon name="info" size="sm" />
            {t.t('admin.studio.custom.classification_default')}
          </p>
        ) : null}
        {raised ? (
          <p
            role="status"
            data-testid="classification-warning"
            className="flex gap-2 rounded-md bg-warning-soft p-3 text-body-sm text-warning-text"
          >
            <Icon name="warning" size="sm" />
            {t.t('admin.studio.custom.classification_raised')}
          </p>
        ) : null}
      </fieldset>

      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId('description')} className="text-body-sm font-semibold">
          {t.t('admin.studio.custom.form.description')}
        </label>
        <textarea
          data-record-text
          id={fieldId('description')}
          name="description"
          rows={2}
          maxLength={DESCRIPTION_MAX}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className={`${FIELD} py-2`}
        />
      </div>

      {showValues ? (
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="text-body-sm font-semibold">{t.t('admin.studio.custom.form.values')}</legend>
          <p id={fieldId('values-hint')} className="text-body-sm text-text-muted">
            {t.t('admin.studio.custom.form.values.hint')}
          </p>
          <ul className="flex flex-col gap-2">
            {existingValues.map((entry) => (
              <li key={entry.value} data-testid="picklist-row" data-value={entry.value} className="flex flex-wrap items-center gap-2">
                <code data-record-text className="min-w-0 break-all font-mono text-mono text-text-2 sm:w-40">
                  {entry.value}
                </code>
                <input
                  type="text"
                  data-part="label"
                  maxLength={LABEL_MAX}
                  aria-label={t.t('admin.studio.custom.form.values.existing', { value: entry.value })}
                  value={valueLabels[entry.value] ?? ''}
                  onChange={(event) => setValueLabels((current) => ({ ...current, [entry.value]: event.target.value }))}
                  className={`${FIELD} min-w-0 flex-1`}
                />
              </li>
            ))}
            {rows.map((row, index) => (
              <li key={row.key} data-testid="picklist-row" className="flex items-center gap-2">
                <input
                  ref={index === 0 ? firstValueRef : undefined}
                  type="text"
                  data-part="label"
                  maxLength={LABEL_MAX}
                  aria-label={t.t('admin.studio.custom.form.values.new')}
                  aria-invalid={problems.values !== undefined && index === 0 ? true : undefined}
                  aria-describedby={
                    problems.values !== undefined && index === 0 ? `${fieldId('values-hint')} ${fieldId('values-error')}` : fieldId('values-hint')
                  }
                  value={row.label}
                  onChange={(event) => {
                    const value = event.target.value;
                    setRows((current) => current.map((entry) => (entry.key === row.key ? { ...entry, label: value } : entry)));
                    setProblems((current) => ({ ...current, values: undefined }));
                  }}
                  className={`${FIELD} min-w-0 flex-1`}
                />
                <button
                  type="button"
                  aria-label={t.t('admin.studio.custom.form.values.drop')}
                  onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}
                  className="flex min-h-touch min-w-touch items-center justify-center rounded-md text-text-muted hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
          {problems.values === undefined ? null : (
            <p id={fieldId('values-error')} className="text-body-sm text-danger-text">
              {t.t(problems.values)}
            </p>
          )}
          {picklistFull ? (
            <p className="text-body-sm text-text-2">{t.t('admin.studio.custom.error.picklist_limit_reached')}</p>
          ) : (
            <div>
              <button ref={addRef} type="button" data-testid="picklist-add" onClick={addRow} className={SECONDARY_BUTTON}>
                <Icon name="add" size="sm" />
                {t.t('admin.studio.custom.form.values.add')}
              </button>
            </div>
          )}
        </fieldset>
      ) : null}

      {refusal === null ? null : (
        <div
          ref={refusalRef}
          tabIndex={-1}
          role="alert"
          data-testid="form-error"
          className="flex gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <Icon name="error" size="sm" />
          <p>{errorText(t, refusal)}</p>
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <button type="button" data-testid="field-cancel" onClick={onCancel} className={SECONDARY_BUTTON}>
          {t.t('admin.studio.custom.form.cancel')}
        </button>
        <button type="submit" data-testid="field-save" aria-disabled={saving} className={`${PRIMARY_BUTTON} aria-disabled:opacity-60`}>
          {t.t(saving ? 'admin.studio.custom.form.saving' : 'admin.studio.custom.form.save')}
        </button>
      </div>
    </form>
  );
}
