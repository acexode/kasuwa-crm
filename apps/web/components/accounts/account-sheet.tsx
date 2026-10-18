'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { Dialog } from '../admin/dialog';
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON } from '../auth/button-classes';
import { LockedValue } from '../records/list-parts';
import { CUSTOM_INVALID, customErrorId, isCustomWithheld, notEditableKeys } from '../../lib/custom-values-core';
import type { CustomChange, CustomDraft } from '../../lib/custom-values-model';
import type { CustomField } from '../../lib/custom-values-api';
import { LazyCustomInputs } from '../custom/lazy-inputs';
import { useCustomModel } from '../custom/use-custom-model';
import type { CustomContext } from '../custom/use-custom-fields';
import { AccountTier, createAccount, updateAccount, type Account, type MyProgramme } from '../../lib/accounts-api';
import type { RecordsError } from '../../lib/records-api';
import {
  NAME_MAX,
  TEXT_MAX,
  accountToForm,
  createBody,
  editBody,
  emptyAccountForm,
  lockedFormFields,
  rebaseAccountForm,
  refusalMessage,
  tierLabel,
  validateAccountForm,
  type AccountForm,
  type AccountFormField,
  type EditableField,
  type FormErrors,
} from './accounts-model';

/**
 * The create / edit sheet on P04/03 (T-0057).
 *
 *   - CREATE asks which programme by NAME when the caller reaches more than
 *     one (`listMyProgrammes`); the id is the select's value and is never
 *     printed. With exactly one there is nothing to ask. The account then
 *     belongs to that programme for good.
 *   - EDIT sends the `version` it was served plus ONLY what changed, and never
 *     a field the row withholds: those are drawn as a lock, not an input, so
 *     they cannot be cleared by accident (the contract refuses it anyway).
 *   - A REFUSAL (403, 409, 400) is a translated `role=alert` in the sheet. The
 *     sheet stays open with everything typed, so nothing is lost (D-L84).
 *   - OFFLINE, Save is off (D-P21: no offline queue). What is typed stays.
 *   - AFTER A 409 a screen may re-read the account (`onRefused`, the P05
 *     record) and pass the fresh row as `mode.row`. The form then becomes the
 *     fresh row with the person's edits laid back on top, and the next save
 *     sends the fresh `version` plus ONLY those edits: a field they did not
 *     touch is never resent, so somebody else's save is never undone. A field
 *     both changed keeps what was typed and says so (`record.conflict.otherChange`).
 *   - SAVE IS ONCE. While a save is in flight the button is `aria-disabled` —
 *     not `disabled`, which would drop keyboard focus to the page — and a
 *     second press does nothing.
 */

const NO_KEYS: ReadonlySet<string> = new Set();
const NO_FIELDS: readonly CustomField[] = [];
const NO_CHANGE: CustomChange = { patch: null, invalid: [] };

export type SheetMode = { readonly kind: 'create' } | { readonly kind: 'edit'; readonly row: Account };

interface Programmes {
  readonly list: readonly MyProgramme[] | null;
  readonly phase: 'loading' | 'loaded' | 'error';
}

/** What every control in the sheet carries: its hook for tests, and its error wiring. */
interface FieldProps {
  readonly id: string;
  readonly 'data-field-input': AccountFormField;
  readonly 'aria-invalid': 'true' | undefined;
  readonly 'aria-describedby': string | undefined;
  readonly className: string;
}

export function AccountSheet({
  t,
  mode,
  programmes,
  online,
  onClose,
  onSaved,
  onRefused,
  custom,
}: {
  t: Translator;
  mode: SheetMode;
  programmes: Programmes;
  online: boolean;
  onClose: () => void;
  onSaved: (row: Account) => void;
  /** A save was refused; the sheet has already said why and kept the form. */
  onRefused?: (error: RecordsError) => void;
  /** The account's custom-field definitions (T-0091), on the record's edit only. */
  custom?: CustomContext;
}) {
  const served = mode.kind === 'edit' ? mode.row : null;
  // The row the form is seeded from: the person's edits are the form's difference from it.
  const [row, setRow] = useState<Account | null>(served);
  const [form, setForm] = useState<AccountForm>(() => (served === null ? emptyAccountForm(programmes.list) : accountToForm(served)));
  const [conflicts, setConflicts] = useState<readonly EditableField[]>([]);
  const [errors, setErrors] = useState<FormErrors>({});
  const [refusal, setRefusal] = useState<MessageId | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const formId = useId();
  const locked = lockedFormFields(row);
  const fields = mode.kind === 'edit' ? (custom?.fields ?? NO_FIELDS) : NO_FIELDS;
  const model = useCustomModel(fields.length > 0);
  const [customDraft, setCustomDraft] = useState<CustomDraft>({});
  const [customInvalid, setCustomInvalid] = useState<readonly string[]>([]);
  // Never sent: a key withheld on THIS record, or one the API has said is read-only (C4, C10).
  const skip = new Set([
    ...(custom?.readOnly ?? []),
    ...fields.filter((field) => isCustomWithheld(row?.withheldFields ?? [], field.apiName)).map((field) => field.apiName),
  ]);
  const changed: CustomChange = model === null ? NO_CHANGE : model.customPatch(fields, row?.custom, customDraft, skip);

  // The definitions arrive after the sheet may have opened: seed the untouched keys from the record.
  useEffect(() => {
    if (model === null) return;
    setCustomDraft((typed) => model.rebaseCustomDraft(fields, undefined, row?.custom, typed));
    // Only a change of the definitions (or the model arriving) re-seeds.
  }, [model, fields]);

  // A fresher row arrived (a re-read after a 409): rebase the edits onto it.
  useEffect(() => {
    if (served === null || row === null || served.version === row.version) return;
    const rebased = rebaseAccountForm(row, served, form);
    if (model !== null) setCustomDraft((typed) => model.rebaseCustomDraft(fields, row.custom, served.custom, typed));
    setRow(served);
    setForm(rebased.form);
    setConflicts((held) => [...new Set([...held.filter((field) => rebased.edited.includes(field)), ...rebased.conflicts])]);
    // Only a new served row starts a rebase; `row` and `form` are read as they stand then.
  }, [served]);

  // With several programmes the target must be chosen; with one it is implied.
  const choices = mode.kind === 'create' ? (programmes.list ?? []) : [];
  const needProgramme = choices.length > 1;
  const waiting = mode.kind === 'create' && programmes.phase === 'loading';
  // The programme's single option is preselected once the list arrives.
  const programmeId = form.programmeId === '' && choices.length === 1 ? (choices[0]?.id ?? '') : form.programmeId;
  const blocked = busy || !online || waiting;

  const set = (field: AccountFormField, value: string) => setForm((current) => ({ ...current, [field]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked) return;
    setRefusal(null);
    const checked = validateAccountForm({ ...form, programmeId }, { needProgramme, locked });
    if (!checked.ok) {
      setErrors(checked.errors);
      // Take the person to the first thing to fix.
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setErrors({});
    setCustomInvalid(changed.invalid);
    if (changed.invalid.length > 0) {
      setRefusal(CUSTOM_INVALID);
      return;
    }

    let body = null;
    if (row !== null) {
      const standard = editBody(row, form, checked.values);
      body = changed.patch === null ? standard : { ...(standard ?? { version: row.version }), custom: changed.patch };
      if (body === null) {
        onClose();
        return;
      }
    }
    setBusy(true);
    const result =
      row === null || body === null
        ? await createAccount(createBody(checked.values, programmeId))
        : await updateAccount(row.id, body);
    if (result.ok) {
      onSaved(result.value);
      return;
    }
    setBusy(false);
    custom?.markReadOnly(notEditableKeys(result.error));
    setRefusal(customErrorId(result.error) ?? refusalMessage(result.error));
    onRefused?.(result.error);
  };

  const fieldProps = (field: AccountFormField): FieldProps => {
    const error = errors[field];
    return {
      id: `${formId}-${field}`,
      'data-field-input': field,
      'aria-invalid': error === undefined ? undefined : 'true',
      'aria-describedby': error === undefined ? undefined : `${formId}-${field}-error`,
      className: `${FIELD} w-full`,
    };
  };

  const text = (field: EditableField, label: MessageId, options: { max: number; hint?: MessageId; required?: boolean; inputMode?: 'tel' } = { max: TEXT_MAX }) =>
    locked.includes(field) ? (
      <LockedField t={t} label={label} />
    ) : (
      <Field t={t} id={`${formId}-${field}`} label={label} hint={options.hint} error={errors[field]} conflict={conflicts.includes(field)}>
        <input
          {...fieldProps(field)}
          type="text"
          value={form[field]}
          maxLength={field === 'tags' || field === 'phones' ? undefined : options.max}
          required={options.required}
          aria-required={options.required}
          inputMode={options.inputMode}
          autoComplete="off"
          aria-describedby={[errors[field] === undefined ? null : `${formId}-${field}-error`, options.hint === undefined ? null : `${formId}-${field}-hint`]
            .filter((value) => value !== null)
            .join(' ') || undefined}
          onChange={(event) => set(field, event.target.value)}
        />
      </Field>
    );

  return (
    <Dialog
      title={t.t(mode.kind === 'create' ? 'accounts.sheet.create' : 'accounts.sheet.edit')}
      icon="domain"
      tone="info"
      closeLabel={t.t('accounts.sheet.close')}
      onClose={onClose}
      testId="account-sheet"
      footer={
        <>
          <button type="button" onClick={onClose} className={QUIET_BUTTON}>
            {t.t('accounts.sheet.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            data-action="save-account"
            data-requires-connection=""
            aria-disabled={blocked ? 'true' : undefined}
            className={`${PRIMARY_BUTTON} aria-disabled:cursor-not-allowed aria-disabled:opacity-60`}
          >
            {busy ? t.t('accounts.sheet.saving') : t.t('accounts.sheet.save')}
          </button>
        </>
      }
    >
      <form ref={formRef} id={formId} noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        {mode.kind === 'create' ? (
          <ProgrammeField
            t={t}
            id={`${formId}-programmeId`}
            programmes={programmes}
            choices={choices}
            value={programmeId}
            error={errors.programmeId}
            fieldProps={fieldProps('programmeId')}
            onChange={(value) => set('programmeId', value)}
          />
        ) : null}

        {text('name', 'accounts.field.name', { max: NAME_MAX, required: true })}

        <div className="grid gap-3 sm:grid-cols-2">
          {text('industry', 'accounts.col.industry')}
          {locked.includes('tier') ? (
            <LockedField t={t} label="accounts.col.tier" />
          ) : (
            <Field t={t} id={`${formId}-tier`} label="accounts.col.tier" error={errors.tier} conflict={conflicts.includes('tier')}>
              <select {...fieldProps('tier')} value={form.tier} onChange={(event) => set('tier', event.target.value)}>
                <option value="">{t.t('records.cell.empty')}</option>
                {AccountTier.options.map((tier) => (
                  <option key={tier} value={tier}>
                    {t.t(tierLabel(tier))}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>

        {text('tags', 'records.col.tags', { max: TEXT_MAX, hint: 'accounts.field.tags.hint' })}
        {text('phones', 'accounts.field.phones', { max: TEXT_MAX, hint: 'accounts.field.phones.hint', inputMode: 'tel' })}

        <div className="grid gap-3 sm:grid-cols-2">
          {text('state', 'accounts.filter.state')}
          {text('lga', 'accounts.filter.lga')}
        </div>

        {model === null ? null : (
        <LazyCustomInputs
          t={t}
          fields={fields}
          draft={customDraft}
          withheldFields={row?.withheldFields ?? []}
          readOnly={custom?.readOnly ?? NO_KEYS}
          disabled={busy}
          invalid={customInvalid}
          onChange={(key, value) => setCustomDraft((current) => ({ ...current, [key]: value }))}
        />
        )}

        {refusal === null ? null : (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
            <Icon name="error" size="sm" />
            {t.t(refusal)}
          </p>
        )}
        {online ? null : (
          <p className="flex items-start gap-2 rounded-md bg-warning-soft p-3 text-body-sm text-warning-text">
            <Icon name="cloud_off" size="sm" />
            {t.t('accounts.sheet.offline')}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function Field({
  t,
  id,
  label,
  hint,
  error,
  conflict = false,
  children,
}: {
  t: Translator;
  id: string;
  label: MessageId;
  hint?: MessageId | undefined;
  error?: MessageId | undefined;
  /** Somebody else changed this field too, since the sheet opened: the typed value is kept. */
  conflict?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-body-sm font-semibold">
        {t.t(label)}
      </label>
      {children}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-caption text-text-2">
          {t.t(hint)}
        </p>
      )}
      {conflict ? (
        <p data-conflict="" className="flex items-start gap-1 text-caption font-semibold text-warning-text">
          <Icon name="info" size="sm" />
          {t.t('record.conflict.otherChange')}
        </p>
      ) : null}
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-caption font-semibold text-danger-text">
          {t.t(error)}
        </p>
      )}
    </div>
  );
}

/** A field this role cannot read: shown as a lock, with why, and never as an input that could clear it. */
function LockedField({ t, label }: { t: Translator; label: MessageId }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-body-sm font-semibold">{t.t(label)}</span>
      <span className="flex min-h-touch items-center rounded-md border border-border bg-surface-sunken px-3 text-body-md text-text-muted">
        <LockedValue t={t} />
      </span>
      <p className="text-caption text-text-2">{t.t('accounts.field.locked')}</p>
    </div>
  );
}

function ProgrammeField({
  t,
  id,
  programmes,
  choices,
  value,
  error,
  fieldProps,
  onChange,
}: {
  t: Translator;
  id: string;
  programmes: Programmes;
  choices: readonly MyProgramme[];
  value: string;
  error: MessageId | undefined;
  fieldProps: FieldProps;
  onChange: (value: string) => void;
}) {
  if (programmes.phase === 'loading') {
    return (
      <p role="status" className="text-body-sm text-text-2">
        {t.t('accounts.field.programme.loading')}
      </p>
    );
  }
  // One programme: nothing to choose, and it is named, not hidden. None, or
  // the list did not load: the server picks the caller's only programme or
  // refuses, and says which.
  if (choices.length === 1) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-body-sm font-semibold">{t.t('accounts.field.programme')}</span>
        <span data-record-text="" className="text-body-md">
          {choices[0]?.name}
        </span>
      </div>
    );
  }
  if (choices.length === 0) return null;
  return (
    <Field t={t} id={id} label="accounts.field.programme" error={error}>
      <select {...fieldProps} value={value} aria-required="true" onChange={(event) => onChange(event.target.value)}>
        <option value="">{t.t('accounts.field.programme.choose')}</option>
        {choices.map((programme) => (
          <option key={programme.id} value={programme.id}>
            {programme.name}
          </option>
        ))}
      </select>
    </Field>
  );
}
