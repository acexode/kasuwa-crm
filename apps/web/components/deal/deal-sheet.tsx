'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { MENU_ROW } from '../records/list-classes';
import {
  DEAL_CURRENCIES,
  searchRecords,
  type PickerRow,
  type PipelineResult,
} from '../../lib/pipelines-api';
import type { DealDetail, UpdateDealBody } from '../../lib/deal-detail-api';
import { CUSTOM_INVALID, customErrorId, isCustomWithheld, namesUnknownField, notEditableKeys } from '../../lib/custom-values-core';
import type { CustomDraft } from '../../lib/custom-values-model';
import type { CustomField } from '../../lib/custom-values-api';
import { LazyCustomInputs } from '../custom/lazy-inputs';
import { useCustomModel } from '../custom/use-custom-model';
import type { CustomContext } from '../custom/use-custom-fields';
import { PipelineDialog } from '../pipeline/pipeline-dialog';
import { errorMessage } from '../pipeline/pipeline-model';
import {
  dealFieldLabel,
  editOutcome,
  editedKeys,
  formOf,
  offeredKeys,
  rebaseForm,
  refusedFields,
  type DealForm,
  type DealFormKey,
  type FormError,
} from './deal-model';

/**
 * Edit the deal (T-0110, R10–R13): one updateDeal carrying `version` and ONLY
 * what the person changed, judged against the deal the sheet stands on. An
 * emptied field is `null`. A withheld field is not offered at all; `name`
 * always is. No owner picker: "assign to me" on the screen is the only
 * reassignment (R11).
 *
 * AFTER A `409 stale_write` the deal is read again and the sheet stays open
 * as the fresh deal with the person's edits laid back on top; a field both
 * changed keeps the typed value and says somebody else changed it (D-L102).
 * Nothing is resent by itself: the person saves again.
 *
 * A refusal (`403 field_not_editable`, `403 not_permitted`) is a translated
 * alert naming fields by label; the sheet and the typing stay; nothing is
 * retried. The amount is typed in MAJOR units in a text input, as T-0109's
 * create form takes it. Contact and account are searches of the deal's own
 * programme, picked by name.
 */

const SEARCH_DEBOUNCE_MS = 300;
const NO_KEYS: ReadonlySet<string> = new Set();
const NO_FIELDS: readonly CustomField[] = [];

type PickerKey = 'primaryContactId' | 'accountId';

export function DealSheet({
  t,
  deal,
  online,
  names,
  onSave,
  onReRead,
  onSaved,
  onClose,
  custom,
}: {
  t: Translator;
  /** The deal the sheet opens on. */
  deal: DealDetail;
  online: boolean;
  /** The served names of the deal's contact and account, for the picked values. */
  names: Readonly<Record<PickerKey, string>>;
  onSave: (body: UpdateDealBody) => Promise<PipelineResult<DealDetail>>;
  /** Reads the deal again after a 409: the fresh deal, or `null` when that read failed. */
  onReRead: () => Promise<DealDetail | null>;
  onSaved: (deal: DealDetail) => void;
  onClose: () => void;
  /** The deal's custom-field definitions (T-0091); none while the feature is off or unread. */
  custom?: CustomContext;
}) {
  const [base, setBase] = useState(deal);
  const [seed, setSeed] = useState<DealForm>(() => formOf(deal));
  const [form, setForm] = useState<DealForm>(seed);
  const [labels, setLabels] = useState<Record<PickerKey, string>>({ ...names });
  const [errors, setErrors] = useState<readonly FormError[]>([]);
  const [conflicts, setConflicts] = useState<readonly string[]>([]);
  const [alert, setAlert] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ids = {
    name: useId(),
    amount: useId(),
    currency: useId(),
    close: useId(),
    next: useId(),
    hint: useId(),
  };
  const offered = new Set(offeredKeys(base));
  const customDefs = custom?.fields ?? NO_FIELDS;
  const model = useCustomModel(customDefs.length > 0);
  const [customDraft, setCustomDraft] = useState<CustomDraft>(() => model.draftOfCustom(customDefs, deal.custom));
  const [customInvalid, setCustomInvalid] = useState<readonly string[]>([]);
  // Never sent: a key withheld on THIS deal, or one the API has said is read-only (C4, C10).
  const skip = new Set([
    ...(custom?.readOnly ?? []),
    ...customDefs.filter((field) => isCustomWithheld(base.withheldFields, field.apiName)).map((field) => field.apiName),
  ]);
  const changed = model.customPatch(customDefs, base.custom, customDraft, skip, t.locale);

  // The definitions arrive after the sheet may have opened: seed the untouched keys from the deal.
  useEffect(() => {
    setCustomDraft((typed) => model.rebaseCustomDraft(customDefs, undefined, base.custom, typed));
    // Only a change of the definitions (or the model arriving) re-seeds.
  }, [model, customDefs]);

  const set = (key: DealFormKey, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !navigator.onLine) return;
    const outcome = editOutcome(base, form, editedKeys(seed, form));
    if (outcome.kind === 'invalid') {
      setErrors(outcome.errors);
      return;
    }
    setErrors([]);
    setCustomInvalid(changed.invalid);
    if (changed.invalid.length > 0) {
      setAlert(t.t(CUSTOM_INVALID));
      return;
    }
    if (outcome.kind === 'unchanged' && changed.patch === null) {
      onClose();
      return;
    }
    const standard = outcome.kind === 'send' ? outcome.body : { version: base.version };
    setSaving(true);
    setAlert(null);
    const result = await onSave(changed.patch === null ? standard : { ...standard, custom: changed.patch });
    if (!mounted.current) return;
    if (result.ok) {
      setSaving(false);
      onSaved(result.value);
      return;
    }
    const { error } = result;
    if (error.code === 'stale_write') {
      // D-L102: read again, keep what was typed, note what somebody else changed.
      const fresh = await onReRead();
      if (!mounted.current) return;
      setSaving(false);
      if (fresh === null) {
        setAlert(t.t(errorMessage(error)));
        return;
      }
      const rebased = rebaseForm(base, fresh, form);
      const freshForm = formOf(fresh);
      // An untouched contact or account takes the fresh deal's, by its served name.
      setLabels((current) => ({
        primaryContactId:
          rebased.form.primaryContactId === freshForm.primaryContactId
            ? (fresh.contact?.displayName ?? '')
            : current.primaryContactId,
        accountId:
          rebased.form.accountId === freshForm.accountId
            ? (fresh.account?.name ?? '')
            : current.accountId,
      }));
      setCustomDraft((typed) => model.rebaseCustomDraft(customDefs, base.custom, fresh.custom, typed));
      setBase(fresh);
      setSeed(freshForm);
      setForm(rebased.form);
      setConflicts(rebased.conflicts);
      setAlert(t.t('deal.edit.stale'));
      return;
    }
    setSaving(false);
    // A refused custom value is its own translated message; a key told read-only stays so, unsent (C4).
    {
      const told = notEditableKeys(error);
      custom?.markReadOnly(told);
      setCustomDraft((typed) => model.resetKeys(customDefs, base.custom, typed, told));
      if (namesUnknownField(error)) custom?.reload();
    }
    const refused = customErrorId(error);
    if (refused !== null) {
      setAlert(t.t(refused));
      return;
    }
    const fields = refusedFields(error);
    setAlert(
      fields.length > 0
        ? t.t('deal.edit.field_not_editable', {
            fields: fields.map((field) => t.t(dealFieldLabel(field))).join(', '),
          })
        : t.t(errorMessage(error)),
    );
  };

  const fieldError = (key: FormError, id: MessageId) =>
    errors.includes(key) ? (
      <p data-field-error={key} className="text-body-sm text-danger-text">
        {t.t(id)}
      </p>
    ) : null;

  const conflict = (field: string) =>
    conflicts.includes(field) ? (
      <p
        data-conflict={field}
        className="flex items-start gap-2 rounded-md bg-warning-soft p-2 text-body-sm text-warning-text"
      >
        <Icon name="info" size="sm" />
        {t.t('deal.edit.conflict')}
      </p>
    ) : null;

  return (
    <PipelineDialog
      testId="deal-sheet"
      title={t.t('deal.edit.title')}
      closeLabel={t.t('pipeline.dialog.close')}
      busy={saving}
      onClose={onClose}
    >
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        {alert === null ? null : (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text"
          >
            <Icon name="error" size="sm" />
            <span>{alert}</span>
          </p>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.name} className="text-body-sm font-semibold">
            {t.t('pipeline.field.name')}
          </label>
          <input
            id={ids.name}
            data-field-input="name"
            value={form.name}
            maxLength={200}
            autoComplete="off"
            aria-invalid={errors.includes('name')}
            onChange={(event) => set('name', event.target.value)}
            className={FIELD}
          />
          {fieldError('name', 'pipeline.create.error.name')}
          {conflict('name')}
        </div>

        {offered.has('amount') ? (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap gap-2">
              <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
                <label htmlFor={ids.amount} className="text-body-sm font-semibold">
                  {t.t('pipeline.field.amount')}
                </label>
                <input
                  id={ids.amount}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  data-field-input="amount"
                  aria-describedby={ids.hint}
                  aria-invalid={errors.includes('amount')}
                  value={form.amount}
                  onChange={(event) => set('amount', event.target.value)}
                  className={FIELD}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={ids.currency} className="text-body-sm font-semibold">
                  {t.t('pipeline.field.currency')}
                </label>
                <select
                  id={ids.currency}
                  data-field-input="currency"
                  aria-invalid={errors.includes('currency')}
                  value={form.currency}
                  onChange={(event) => set('currency', event.target.value)}
                  className={FIELD}
                >
                  <option value="">{t.t('pipeline.create.currency.choose')}</option>
                  {DEAL_CURRENCIES.map((code) => (
                    <option key={code} value={code} data-record-text="">
                      {code}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p id={ids.hint} className="text-caption text-text-muted">
              {t.t('pipeline.create.amountHint')}
            </p>
            {fieldError('amount', 'pipeline.create.error.amount')}
            {fieldError('currency', 'pipeline.create.error.currency')}
            {conflict('amount')}
          </div>
        ) : null}

        {offered.has('expectedCloseDate') ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.close} className="text-body-sm font-semibold">
              {t.t('pipeline.field.expectedCloseDate')}
            </label>
            <input
              id={ids.close}
              type="date"
              data-field-input="expectedCloseDate"
              value={form.expectedCloseDate}
              onChange={(event) => set('expectedCloseDate', event.target.value)}
              className={FIELD}
            />
            {conflict('expectedCloseDate')}
          </div>
        ) : null}

        {offered.has('nextStep') ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.next} className="text-body-sm font-semibold">
              {t.t('pipeline.field.nextStep')}
            </label>
            <input
              id={ids.next}
              data-field-input="nextStep"
              value={form.nextStep}
              maxLength={200}
              autoComplete="off"
              onChange={(event) => set('nextStep', event.target.value)}
              className={FIELD}
            />
            {conflict('nextStep')}
          </div>
        ) : null}

        {(['primaryContactId', 'accountId'] as const).map((key) =>
          offered.has(key) ? (
            <RecordPicker
              key={key}
              t={t}
              kind={key}
              programmeId={base.programmeId}
              pickedId={form[key]}
              pickedName={labels[key]}
              onPick={(row) => {
                setLabels((current) => ({ ...current, [key]: row?.name ?? '' }));
                set(key, row?.id ?? '');
              }}
            >
              {conflict(key)}
            </RecordPicker>
          ) : null,
        )}

        <LazyCustomInputs
          t={t}
          fields={customDefs}
          draft={customDraft}
          withheldFields={base.withheldFields}
          readOnly={custom?.readOnly ?? NO_KEYS}
          disabled={saving}
          invalid={customInvalid}
          onChange={(key, value) => setCustomDraft((current) => ({ ...current, [key]: value }))}
        />

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className={`${SECONDARY_BUTTON} disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {t.t('pipeline.cancel')}
          </button>
          <button
            type="submit"
            data-action="save-deal"
            data-requires-connection=""
            disabled={!online || saving}
            className={`${PRIMARY_BUTTON} disabled:cursor-not-allowed`}
          >
            {saving ? t.t('record.saving') : t.t('deal.edit.save')}
          </button>
        </div>
      </form>
    </PipelineDialog>
  );
}

/**
 * The contact or the account: what is picked (by name, never an id), a way to
 * clear it, and a search of the deal's own programme to pick another.
 */
function RecordPicker({
  t,
  kind,
  programmeId,
  pickedId,
  pickedName,
  onPick,
  children,
}: {
  t: Translator;
  kind: PickerKey;
  programmeId: string;
  pickedId: string;
  pickedName: string;
  onPick: (row: PickerRow | null) => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<readonly PickerRow[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const sequence = useRef(0);
  const searchId = useId();
  const label = t.t(dealFieldLabel(kind));

  useEffect(() => {
    const q = query.trim();
    sequence.current += 1;
    const mine = sequence.current;
    if (q === '') {
      setRows(null);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void searchRecords(kind, q, programmeId).then((result) => {
        if (mine !== sequence.current) return;
        if (result.ok) {
          setRows(result.value);
          setFailed(null);
        } else {
          setRows(null);
          setFailed(t.t(errorMessage(result.error, 'read')));
        }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, kind, programmeId, t]);

  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="text-body-sm font-semibold">{label}</legend>
      <div className="flex min-h-touch flex-wrap items-center gap-2 rounded-md bg-surface-sunken px-3 text-body-sm">
        <Icon
          name={kind === 'accountId' ? 'domain' : 'person'}
          size="sm"
          className="text-text-muted"
        />
        {pickedId === '' ? (
          <span className="flex-1 text-text-muted">{t.t('records.cell.empty')}</span>
        ) : (
          <span data-record-text="" className="min-w-0 flex-1 break-words font-semibold">
            {pickedName}
          </span>
        )}
        {pickedId === '' ? null : (
          <button
            type="button"
            data-field-clear={kind}
            onClick={() => onPick(null)}
            className={QUIET_BUTTON}
          >
            <Icon name="close" size="sm" />
            {t.t('deal.edit.clear')}
          </button>
        )}
      </div>
      <label htmlFor={searchId} className="sr-only">
        {t.t('pipeline.prompt.search')}
      </label>
      <input
        id={searchId}
        type="search"
        autoComplete="off"
        maxLength={100}
        data-field-input={kind}
        placeholder={t.t('pipeline.prompt.search')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Escape empties the search first; only an empty search lets it close the sheet.
          if (event.key !== 'Escape' || query === '') return;
          event.preventDefault();
          setQuery('');
        }}
        className={FIELD}
      />
      {failed === null ? null : <p className="text-body-sm text-danger-text">{failed}</p>}
      {rows === null ? null : rows.length === 0 ? (
        <p className="text-body-sm text-text-2">{t.t('pipeline.prompt.noMatches')}</p>
      ) : (
        <div role="group" aria-label={t.t('pipeline.prompt.results')} className="flex flex-col">
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              data-picker-option={row.id}
              onClick={() => {
                onPick(row);
                setQuery('');
              }}
              className={`${MENU_ROW} text-text`}
            >
              <Icon
                name={kind === 'accountId' ? 'domain' : 'person'}
                size="sm"
                className="text-text-muted"
              />
              <span data-record-text="">{row.name}</span>
            </button>
          ))}
        </div>
      )}
      {children}
    </fieldset>
  );
}
