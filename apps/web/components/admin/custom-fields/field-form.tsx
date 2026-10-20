'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { localeLabel, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../../icon';
import { saveFieldSecurityMatrix, type FieldAccessLevel, type ScreenError } from '../../../lib/admin-api';
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
import { SecurityTab, type SecurityState } from './security-tab';
import {
  STUDIO_DANGER_GHOST,
  STUDIO_INPUT,
  STUDIO_LABEL,
  STUDIO_PRIMARY,
  STUDIO_SECONDARY,
} from './studio-classes';
import { CLASSIFICATION_LABEL, TYPE_CARDS, TYPE_ICON, TYPE_LABEL, currencyOptionLabel, errorText } from './studio-text';

/**
 * `P18/B` — the field form, drawn as the export's field editor (T-0142): the
 * Properties, Security and Translations tabs over a scrolling body, and a
 * footer with the save. Create takes the api name, label, type (the export's
 * card grid), classification and the config only a picklist or a currency
 * takes; edit takes the label, description, classification and picklist
 * values only.
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
 * The Security tab edits this field's row of the field-security matrix, saved
 * with the matrix's own write after the field's, so P02/D and the studio never
 * disagree. A refusal keeps the draft. The API's 403 is the write gate (D-L84).
 *
 * WHAT THE EXPORT DRAWS THAT THE CONTRACT DOES NOT HAVE (D-L194, D-L195)
 * The eight types the contract refuses are drawn disabled behind
 * `custom_field_types_extended`; usage and the Required, Unique and Filterable
 * switches behind `studio_field_usage`; the Translations tab behind
 * `studio_field_translations`. The type can never change, so the export's
 * type select is a locked value and its "Delete" is Retire.
 * ---------------------------------------------------------------------------
 */

interface NewRow {
  readonly key: number;
  label: string;
}

type Problems = { [K in 'label' | 'apiName' | 'currency' | 'values']?: MessageId | undefined };

type Tab = 'props' | 'security' | 'translations';

export type SavedKind = 'created' | 'updated';

export interface FormFlags {
  readonly extendedTypes: boolean;
  readonly usage: boolean;
  /**
   * The menu's languages other than English, for the Translations tab; empty
   * while `studio_field_translations` is off. Read on the server, because the
   * list lives beside the catalogues, which no client chunk may import.
   */
  readonly translations: readonly string[];
}

function Note({ id, children, tone = 'muted' }: { id?: string; children: ReactNode; tone?: 'muted' | 'danger' }) {
  return (
    <p id={id} className={`text-caption font-normal ${tone === 'danger' ? 'font-semibold text-danger-text' : 'text-text-muted'}`}>
      {children}
    </p>
  );
}

function OptionSwitch({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-3.5 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="text-body-sm">{title}</b>
        <span className="text-caption font-normal text-text-2">{body}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked="false"
        aria-label={title}
        disabled
        className="flex h-6.5 w-11 shrink-0 cursor-not-allowed items-center rounded-full bg-disabled-bg p-0.75 shadow-switch-disabled"
      >
        <span className="size-5 rounded-full bg-surface shadow-knob" />
      </button>
    </div>
  );
}

export function FieldForm({
  t,
  locale,
  mode,
  object,
  field,
  limits,
  flags,
  onSaved,
  onCancel,
  onStale,
  onState,
  onType,
  onRetire,
}: {
  t: Translator;
  locale: string;
  mode: 'create' | 'edit';
  object: CustomFieldObject;
  /** Edit mode only. */
  field?: CustomFieldDefinition;
  limits: CustomFieldLimits;
  flags: FormFlags;
  onSaved: (kind: SavedKind) => void;
  onCancel: () => void;
  /** The field is gone or retired under us: the list must be read again. */
  onStale: () => void;
  /** What leaving would lose, and whether a write is in flight, for the screen's guards. */
  onState: (state: { dirty: boolean; saving: boolean }) => void;
  /** The chosen type, for the editor's header. */
  onType?: (type: CustomFieldType) => void;
  /** Edit mode: the footer's Retire, which opens the screen's confirmation. */
  onRetire?: (from: HTMLElement) => void;
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

  const [tab, setTab] = useState<Tab>('props');
  const [visited, setVisited] = useState<readonly Tab[]>(['props']);
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
  const [focusFirstProblem, setFocusFirstProblem] = useState(0);
  const [refusal, setRefusal] = useState<ScreenError | null>(null);
  const [saving, setSaving] = useState(false);
  const [security, setSecurity] = useState<SecurityState | null>(null);
  const [securityChanges, setSecurityChanges] = useState<Readonly<Record<string, FieldAccessLevel>>>({});

  // Focus moves into the form when it opens, so a keyboard or screen-reader user lands in it.
  useEffect(() => {
    labelRef.current?.focus();
  }, []);

  // A refusal is announced AND reached: focus moves to it, so a keyboard user
  // is not left on a control that has just been disabled or replaced.
  useEffect(() => {
    if (refusal !== null) refusalRef.current?.focus();
  }, [refusal]);

  useEffect(() => {
    onType?.(type);
  }, [type, onType]);

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

  const showTab = (next: Tab) => {
    setTab(next);
    setVisited((current) => (current.includes(next) ? current : [...current, next]));
  };

  const onSecurityChange = useCallback((permissionSetId: string, level: FieldAccessLevel | null) => {
    setSecurityChanges((current) => {
      const next = { ...current };
      if (level === null) delete next[permissionSetId];
      else next[permissionSetId] = level;
      return next;
    });
  }, []);
  const onSecurityLoaded = useCallback((state: SecurityState | null) => setSecurity(state), []);

  // The first invalid control is focused once the Properties tab is showing again.
  useEffect(() => {
    if (focusFirstProblem === 0) return;
    const first = problems.label
      ? labelRef.current
      : problems.apiName
        ? apiNameRef.current
        : problems.currency
          ? currencyRef.current
          : (firstValueRef.current ?? addRef.current);
    first?.focus();
    // Only when a submit asked for it, not on every edit of `problems`.
  }, [focusFirstProblem]);

  const draft = { label, description, classification, valueLabels, newLabels: rows.map((row) => row.label) };
  const editChanges = editField === undefined ? {} : updateBody(editField, draft);
  const securityCount = Object.keys(securityChanges).length;

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
      setTab('props');
      setFocusFirstProblem((current) => current + 1);
      return;
    }
    setProblems({});

    inFlight.current = true;
    setSaving(true);
    let failure: ScreenError | null = null;
    let kind: SavedKind = 'created';

    if (editField !== undefined) {
      kind = 'updated';
      const body = editChanges;
      if (Object.keys(body).length === 0 && securityCount === 0) {
        // Nothing changed: there is nothing to send, and an empty update is not a valid one.
        inFlight.current = false;
        setSaving(false);
        onCancel();
        return;
      }
      if (Object.keys(body).length > 0) {
        const result = await updateCustomField(editField.id, body);
        if (!result.ok) failure = result.error;
      }
      if (failure === null && securityCount > 0 && security !== null) {
        const result = await saveFieldSecurityMatrix({
          objectApiName: object,
          version: security.version,
          changes: Object.entries(securityChanges).map(([permissionSetId, level]) => ({
            fieldApiName: editField.apiName,
            permissionSetId,
            level,
          })),
        });
        if (!result.ok) failure = result.error;
      }
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

  const propsCount = Object.keys(editChanges).length;
  const dirty =
    editField === undefined
      ? createDirty({ label, apiName, type, classification, description, currency, newLabels: rows.map((row) => row.label) })
      : propsCount > 0 || securityCount > 0;
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
  const shownType = editField?.type ?? type;
  const showValues = shownType === 'picklist';
  const savedCurrency = editField === undefined ? null : currencyOf(editField);
  const showConfig = showValues || shownType === 'currency';
  const changeCount = propsCount + securityCount;

  const tabs: readonly { readonly id: Tab; readonly label: string; readonly badge: number }[] = [
    { id: 'props', label: t.t('admin.studio.editor.tab.properties'), badge: propsCount },
    { id: 'security', label: t.t('admin.studio.editor.tab.security'), badge: securityCount },
    ...(flags.translations.length > 0 ? [{ id: 'translations' as const, label: t.t('admin.studio.editor.tab.translations'), badge: 0 }] : []),
  ];

  const segment = (on: boolean) =>
    `relative inline-flex h-control-base min-w-16 items-center justify-center rounded-md px-3 text-meta font-bold has-[:focus-visible]:ring-focus md:h-8 ${
      on ? 'bg-primary-soft text-primary-text' : 'cursor-pointer text-text-2 is-hover:bg-surface-sunken'
    }`;

  return (
    <form
      data-testid="field-form"
      data-mode={mode}
      noValidate
      aria-label={editField === undefined ? t.t('admin.studio.editor.new') : editField.label}
      onSubmit={(event) => void submit(event)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div role="tablist" aria-label={t.t('admin.studio.editor.tabs')} className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-border px-3">
        {tabs.map((entry) => {
          const on = entry.id === tab;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={fieldId(`tab-${entry.id}`)}
              aria-selected={on}
              aria-controls={fieldId(`panel-${entry.id}`)}
              onClick={() => showTab(entry.id)}
              className={`-mb-px inline-flex h-control-base shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-body-sm font-semibold outline-none focus-visible:ring-focus ${
                on ? 'border-primary text-text' : 'border-transparent text-text-2 is-hover:text-text'
              }`}
            >
              {entry.label}
              {entry.badge === 0 ? null : (
                <span className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-warning-soft px-1 text-micro text-warning-text">
                  <span className="sr-only">{t.t('admin.studio.editor.changed')}</span>
                  {entry.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* ------------------------------------------------------------ Properties */}
        <div
          role="tabpanel"
          id={fieldId('panel-props')}
          aria-labelledby={fieldId('tab-props')}
          hidden={tab !== 'props'}
          className={`${tab === 'props' ? 'flex' : 'hidden'} flex-col gap-4.5 px-5 pb-6 pt-4.5`}
        >
          {flags.usage && editField !== undefined ? (
            <div className="flex items-start gap-2.5 rounded-10 bg-info-soft px-3.5 py-3 text-info-text">
              <Icon name="hub" size={20} />
              <div className="flex flex-1 flex-col gap-0.5">
                <b className="text-body-sm">{t.t('admin.studio.usage.title')}</b>
                <span className="text-meta text-text">{t.t('admin.studio.usage.none')}</span>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className={STUDIO_LABEL}>
                <label htmlFor={fieldId('label')}>{t.t('admin.studio.custom.form.label')}</label>
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
                  className={STUDIO_INPUT}
                />
              </div>
              <div className={STUDIO_LABEL}>
                <label htmlFor={fieldId('apiName')} className="flex items-center gap-1">
                  {t.t('admin.studio.custom.form.apiName')}
                  {editing ? <Icon name="lock" size={15} className="text-text-muted" /> : null}
                </label>
                {editField !== undefined ? (
                  <input
                    id={fieldId('apiName')}
                    name="apiName"
                    type="text"
                    dir="ltr"
                    data-record-text
                    value={editField.apiName}
                    disabled
                    aria-describedby={fieldId('apiName-hint')}
                    className={`${STUDIO_INPUT} font-mono text-meta`}
                  />
                ) : (
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
                    className={`${STUDIO_INPUT} font-mono text-meta`}
                  />
                )}
              </div>
            </div>
            {problems.label === undefined ? null : (
              <Note id={fieldId('label-error')} tone="danger">
                {t.t(problems.label)}
              </Note>
            )}
            <Note id={fieldId('apiName-hint')}>
              {t.t(editing ? 'admin.studio.editor.apiName.locked' : 'admin.studio.custom.form.apiName.hint')}
            </Note>
            {problems.apiName === undefined ? null : (
              <Note id={fieldId('apiName-error')} tone="danger">
                {t.t(problems.apiName)}
              </Note>
            )}
          </div>

          {editField !== undefined ? (
            <div className={STUDIO_LABEL}>
              <span>{t.t('admin.studio.custom.form.type')}</span>
              <span className="flex h-control-base items-center gap-2 rounded-md border border-border bg-disabled-bg px-3 text-body-sm font-normal text-text-2 md:h-control-md">
                <Icon name={TYPE_ICON[editField.type]} size={18} />
                <span className="flex-1">{t.t(TYPE_LABEL[editField.type])}</span>
                <Icon name="lock" size={16} className="text-text-muted" />
              </span>
              <Note>{t.t('admin.studio.custom.form.type.hint')}</Note>
            </div>
          ) : (
            <fieldset className="flex min-w-0 flex-col gap-3" aria-describedby={fieldId('type-hint')}>
              <legend className="mb-1.5 text-meta font-bold">{t.t('admin.studio.custom.form.type')}</legend>
              <p id={fieldId('type-hint')} className="text-body-relaxed text-text-2">
                {t.t('admin.studio.editor.chooseType')}
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {TYPE_CARDS.filter((card) => card.supported || flags.extendedTypes).map((card) => {
                  const on = card.supported && card.id === type;
                  return (
                    <label
                      key={card.id}
                      className={`relative flex items-start gap-2.5 rounded-10 border p-3 text-start has-[:focus-visible]:ring-focus ${
                        !card.supported
                          ? 'cursor-not-allowed border-border bg-surface-sunken text-text-muted'
                          : on
                            ? 'cursor-pointer border-primary-soft-strong bg-primary-soft text-text'
                            : 'cursor-pointer border-border bg-surface text-text is-hover:border-primary'
                      }`}
                    >
                      <input
                        type="radio"
                        name="type"
                        value={card.id}
                        checked={on}
                        disabled={!card.supported}
                        onChange={() => {
                          const parsed = CustomFieldTypeSchema.safeParse(card.id);
                          if (parsed.success) setType(parsed.data);
                        }}
                        className="sr-only"
                      />
                      <Icon name={card.icon} size={22} className={card.supported ? 'text-primary-text' : 'text-text-muted'} />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <b className="text-body-sm">{t.t(card.label)}</b>
                        <span className={`text-caption font-normal ${card.supported ? 'text-text-2' : 'text-text-muted'}`}>
                          {t.t(card.supported ? card.description : 'admin.studio.type.soon')}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}

          {showConfig ? (
            <div className="flex flex-col gap-3 rounded-10 bg-surface-sunken p-3.5">
              {shownType === 'currency' ? (
                editField !== undefined ? (
                  <div className={STUDIO_LABEL}>
                    <span>{t.t('admin.studio.custom.form.currency')}</span>
                    <span className="flex h-control-base items-center gap-2 rounded-md border border-border bg-disabled-bg px-3 text-body-sm font-normal text-text-2 md:h-control-md">
                      <span className="flex-1">{savedCurrency === null ? '' : currencyOptionLabel(t, locale, savedCurrency)}</span>
                      <Icon name="lock" size={16} className="text-text-muted" />
                    </span>
                  </div>
                ) : (
                  <div className={STUDIO_LABEL}>
                    <label htmlFor={fieldId('currency')}>{t.t('admin.studio.custom.form.currency')}</label>
                    <span className="relative block">
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
                        className={`${STUDIO_INPUT} appearance-none pe-9`}
                      >
                        <option value="">{t.t('admin.studio.custom.form.currency.choose')}</option>
                        {CURRENCY_CODES.map((code) => (
                          <option key={code} value={code}>
                            {currencyOptionLabel(t, locale, code)}
                          </option>
                        ))}
                      </select>
                      <Icon name="expand_more" size={20} className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-text-2" />
                    </span>
                  </div>
                )
              ) : null}
              {shownType === 'currency' ? (
                <Note id={fieldId('currency-hint')}>{t.t('admin.studio.custom.form.currency.hint')}</Note>
              ) : null}
              {problems.currency === undefined ? null : (
                <Note id={fieldId('currency-error')} tone="danger">
                  {t.t(problems.currency)}
                </Note>
              )}

              {showValues ? (
                <fieldset className="flex min-w-0 flex-col gap-1.5">
                  <legend className="mb-1.5 text-meta font-bold">{t.t('admin.studio.custom.form.values')}</legend>
                  <Note id={fieldId('values-hint')}>{t.t('admin.studio.custom.form.values.hint')}</Note>
                  <ul className="flex flex-col gap-1.5">
                    {existingValues.map((entry, index) => (
                      <li key={entry.value} data-testid="picklist-row" data-value={entry.value} className="flex items-center gap-1.5">
                        <span aria-hidden="true" className="w-5.5 shrink-0 text-end text-caption font-normal text-text-muted">
                          {index + 1}
                        </span>
                        <input
                          type="text"
                          data-part="label"
                          maxLength={LABEL_MAX}
                          aria-label={t.t('admin.studio.custom.form.values.existing', { value: entry.value })}
                          value={valueLabels[entry.value] ?? ''}
                          onChange={(event) => setValueLabels((current) => ({ ...current, [entry.value]: event.target.value }))}
                          className={`${STUDIO_INPUT} md:h-control-sm`}
                        />
                        <code data-record-text dir="ltr" className="hidden max-w-32 shrink-0 truncate font-mono text-caption text-text-muted sm:block">
                          {entry.value}
                        </code>
                      </li>
                    ))}
                    {rows.map((row, index) => (
                      <li key={row.key} data-testid="picklist-row" className="flex items-center gap-1.5">
                        <span aria-hidden="true" className="w-5.5 shrink-0 text-end text-caption font-normal text-text-muted">
                          {existingValues.length + index + 1}
                        </span>
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
                          className={`${STUDIO_INPUT} md:h-control-sm`}
                        />
                        <button
                          type="button"
                          aria-label={t.t('admin.studio.custom.form.values.drop')}
                          onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}
                          className="flex size-touch shrink-0 items-center justify-center rounded-md text-text-muted outline-none is-hover:bg-surface focus-visible:ring-focus md:size-control-sm"
                        >
                          <Icon name="close" size={18} />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {problems.values === undefined ? null : (
                    <Note id={fieldId('values-error')} tone="danger">
                      {t.t(problems.values)}
                    </Note>
                  )}
                  {picklistFull ? (
                    <Note>{t.t('admin.studio.custom.error.picklist_limit_reached')}</Note>
                  ) : (
                    <button
                      ref={addRef}
                      type="button"
                      data-testid="picklist-add"
                      onClick={addRow}
                      className="ms-7 inline-flex h-control-base items-center gap-1 self-start rounded-6 px-2 text-meta font-bold text-primary-text outline-none is-hover:bg-primary-soft focus-visible:ring-focus md:h-8"
                    >
                      <Icon name="add" size={18} />
                      {t.t('admin.studio.custom.form.values.add')}
                    </button>
                  )}
                </fieldset>
              ) : null}
            </div>
          ) : null}

          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="mb-1.5 text-meta font-bold">{t.t('admin.studio.custom.form.classification')}</legend>
            <div className="flex flex-wrap gap-0.5 self-start rounded-10 border border-border bg-surface p-0.5">
              {CLASSIFICATIONS.map((level) => (
                <label key={level} className={segment(classification === level)}>
                  <input
                    type="radio"
                    name="classification"
                    value={level}
                    checked={classification === level}
                    onChange={() => setClassification(level)}
                    className="sr-only"
                  />
                  {t.t(CLASSIFICATION_LABEL[level])}
                </label>
              ))}
            </div>
            {showDefaultNote ? (
              <p
                role="note"
                data-testid="classification-default-note"
                className="flex gap-2 rounded-10 bg-info-soft px-3.5 py-2.5 text-meta text-info-text"
              >
                <Icon name="info" size={18} />
                {t.t('admin.studio.custom.classification_default')}
              </p>
            ) : null}
            {raised ? (
              <p
                role="status"
                data-testid="classification-warning"
                className="flex gap-2 rounded-10 bg-warning-soft px-3.5 py-2.5 text-meta text-warning-text"
              >
                <Icon name="warning" size={18} />
                {t.t('admin.studio.custom.classification_raised')}
              </p>
            ) : null}
          </fieldset>

          {flags.usage ? (
            <div className="flex flex-col rounded-10 border border-border">
              <OptionSwitch title={t.t('admin.studio.option.required')} body={t.t('admin.studio.option.required.desc')} />
              <OptionSwitch title={t.t('admin.studio.option.unique')} body={t.t('admin.studio.option.unique.desc')} />
              <OptionSwitch title={t.t('admin.studio.option.filterable')} body={t.t('admin.studio.option.filterable.desc')} />
            </div>
          ) : null}

          <div className={STUDIO_LABEL}>
            <label htmlFor={fieldId('description')}>{t.t('admin.studio.custom.form.description')}</label>
            <textarea
              data-record-text
              id={fieldId('description')}
              name="description"
              rows={2}
              maxLength={DESCRIPTION_MAX}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className={`${STUDIO_INPUT} h-auto py-2.5 md:h-auto`}
            />
          </div>

          {refusal === null ? null : (
            <div
              ref={refusalRef}
              tabIndex={-1}
              role="alert"
              data-testid="form-error"
              className="flex gap-2 rounded-10 bg-danger-soft px-3.5 py-3 text-meta text-danger-text outline-none focus-visible:ring-focus"
            >
              <Icon name="error" size={18} />
              <p>{errorText(t, refusal)}</p>
            </div>
          )}
        </div>

        {/* ------------------------------------------------------------ Security */}
        <div
          role="tabpanel"
          id={fieldId('panel-security')}
          aria-labelledby={fieldId('tab-security')}
          hidden={tab !== 'security'}
          className={`${tab === 'security' ? 'flex' : 'hidden'} flex-col gap-4 px-5 pb-6 pt-4.5`}
        >
          {editField === undefined ? (
            <>
              <p className="text-meta text-text-2">{t.t('admin.studio.security.intro')}</p>
              <p className="rounded-10 bg-surface-sunken px-3.5 py-3 text-meta text-text-2">{t.t('admin.studio.security.afterCreate')}</p>
            </>
          ) : visited.includes('security') ? (
            <SecurityTab
              t={t}
              object={object}
              apiName={editField.apiName}
              changes={securityChanges}
              onChange={onSecurityChange}
              onLoaded={onSecurityLoaded}
            />
          ) : null}
        </div>

        {/* ------------------------------------------------------------ Translations */}
        {flags.translations.length > 0 ? (
          <div
            role="tabpanel"
            id={fieldId('panel-translations')}
            aria-labelledby={fieldId('tab-translations')}
            hidden={tab !== 'translations'}
            className={`${tab === 'translations' ? 'flex' : 'hidden'} flex-col gap-4 px-5 pb-6 pt-4.5`}
          >
            <div className="flex flex-wrap items-center gap-2.5">
              <p className="min-w-0 flex-1 basis-48 text-meta text-text-2">{t.t('admin.studio.translations.intro')}</p>
              <button type="button" disabled className={`${STUDIO_SECONDARY} md:h-control-sm`}>
                {t.t('admin.studio.translations.send', { count: flags.translations.length })}
              </button>
            </div>
            <div className="flex flex-col gap-1 rounded-10 bg-surface-sunken px-3.5 py-3">
              <span className="text-caption font-bold text-text-muted">{t.t('admin.studio.translations.default', { language: localeLabel('en') })}</span>
              <b data-record-text className="text-body-sm">
                {label.trim() === '' ? t.t('admin.studio.editor.new') : label}
              </b>
              {description.trim() === '' ? null : (
                <span data-record-text className="text-meta text-text-2">
                  {description}
                </span>
              )}
            </div>
            {flags.translations.map((entry) => (
              <div key={entry} className="flex flex-col gap-2 rounded-10 border border-border px-3.5 py-3">
                <div className="flex items-center gap-2">
                  <b lang={entry} className="flex-1 text-body-sm">
                    {localeLabel(entry)}
                  </b>
                  <span className="inline-flex h-5.5 items-center rounded-full bg-surface-sunken px-2 text-micro text-text-2">
                    {t.t('admin.studio.translations.missing')}
                  </span>
                </div>
                <input
                  type="text"
                  disabled
                  aria-label={t.t('admin.studio.translations.label', { language: localeLabel(entry) })}
                  placeholder={label}
                  className={`${STUDIO_INPUT} md:h-control-sm`}
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2.5 border-t border-border bg-surface py-3 pe-4 ps-5">
        {editField === undefined ? (
          <>
            <span className="hidden min-w-0 flex-1 text-caption font-normal text-text-muted sm:block">
              {label.trim() === '' ? t.t('admin.studio.editor.addLabel') : ''}
            </span>
            <button type="button" data-testid="field-cancel" onClick={onCancel} className={STUDIO_SECONDARY}>
              {t.t('admin.studio.custom.form.cancel')}
            </button>
            <button type="submit" data-testid="field-save" aria-disabled={saving} className={`${STUDIO_PRIMARY} aria-disabled:bg-disabled-bg aria-disabled:text-disabled-text`}>
              {t.t(saving ? 'admin.studio.custom.form.saving' : 'admin.studio.editor.create')}
            </button>
          </>
        ) : (
          <>
            {onRetire === undefined ? null : (
              <button type="button" onClick={(event) => onRetire(event.currentTarget)} className={STUDIO_DANGER_GHOST}>
                <Icon name="archive" size={18} />
                {t.t('admin.studio.custom.retire')}
              </button>
            )}
            <span className="flex-1" />
            {changeCount === 0 ? (
              <span className="inline-flex items-center gap-1 text-meta text-text-muted">
                <Icon name="cloud_done" size={16} />
                {t.t('admin.studio.editor.saved')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-meta font-semibold text-warning-text">
                <Icon name="edit_note" size={16} />
                {t.t('admin.studio.editor.unsaved', { count: changeCount })}
              </span>
            )}
            <button type="button" data-testid="field-cancel" onClick={onCancel} className={STUDIO_SECONDARY}>
              {t.t(changeCount === 0 ? 'admin.studio.editor.close' : 'admin.studio.editor.discard')}
            </button>
            <button type="submit" data-testid="field-save" aria-disabled={saving} className={`${STUDIO_PRIMARY} aria-disabled:bg-disabled-bg aria-disabled:text-disabled-text`}>
              {t.t(saving ? 'admin.studio.custom.form.saving' : 'admin.studio.editor.save')}
            </button>
          </>
        )}
      </div>
    </form>
  );
}
