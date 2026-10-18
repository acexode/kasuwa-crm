'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { Dialog } from '../admin/dialog';
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON } from '../auth/button-classes';
import { ConsentState, PreferredChannel, type RecordsResult } from '../../lib/records-api';
import type { ContactRecord } from '../../lib/contact-record-api';
import {
  LANGUAGE_CODES,
  draftOf,
  editableKeys,
  fieldLabel,
  languageLabel,
  rebaseDraft,
  saveBody,
  type Draft,
  type EditKey,
} from './record-model';
import { writeErrorId } from '../record/record-core';
import {
  CUSTOM_INVALID,
  customErrorId,
  customPatch,
  draftOfCustom,
  isCustomWithheld,
  notEditableKeys,
  rebaseCustomDraft,
  type CustomDraft,
} from '../../lib/custom-values-model';
import type { CustomField } from '../../lib/custom-values-api';
import { CustomInputs } from '../custom/custom-inputs';
import type { CustomContext } from '../custom/use-custom-fields';

/**
 * The full edit (P05/01's pencil, for writers). A dialog, so focus moves in,
 * is trapped, and goes back to the Edit button on close (`admin/dialog.tsx`).
 *
 * IT OFFERS ONLY WHAT THE CALLER CAN READ, AND SENDS ONLY WHAT CHANGED. A
 * withheld field is not drawn here at all (a caller cannot clear what they
 * cannot see), and the body is `version` plus the fields whose value differs
 * from the record as served (`changedFields`). Programme, source, DND and the
 * network are never offered: none of them is a hand edit.
 *
 * AFTER A 409 the screen re-reads the contact and passes it as `record`. The
 * draft then becomes the fresh record with the person's edits laid back on
 * top, and the next save sends ITS `version` plus only those edits: a field
 * they did not touch is never resent, so somebody else's save is never
 * undone. A field both changed keeps what was typed and says so.
 *
 * D-L84: no read tells the screen whether the caller may write, so the sheet
 * opens for everyone and the API's 403 is the gate. A refusal is an alert in
 * the reader's language; the sheet and everything typed stay.
 */

const NO_KEYS: ReadonlySet<string> = new Set();
const NO_FIELDS: readonly CustomField[] = [];

const TEXT_KEYS = new Set<EditKey>(['displayName', 'givenNames', 'familyName', 'state', 'lga', 'tags']);
const LIST_KEYS: Partial<Record<EditKey, MessageId>> = {
  phones: 'record.sheet.phonesHint',
  emails: 'record.sheet.emailsHint',
};

function label(key: EditKey): MessageId {
  return key === 'whatsappOptIn' ? 'records.wa.in' : (fieldLabel(key) ?? 'records.col.displayName');
}

export function ContactSheet({
  t,
  record,
  offline,
  custom,
  onSave,
  onClose,
}: {
  t: Translator;
  record: ContactRecord;
  offline: boolean;
  /** The contact's custom-field definitions (T-0091); none while the feature is off or unread. */
  custom?: CustomContext;
  onSave: (body: Readonly<Record<string, unknown>>) => Promise<RecordsResult<ContactRecord>>;
  onClose: () => void;
}) {
  // The record the draft is seeded from: the person's edits are the draft's difference from it.
  const [base, setBase] = useState<ContactRecord>(record);
  const [draft, setDraft] = useState<Draft>(() => draftOf(record));
  const [conflicts, setConflicts] = useState<readonly EditKey[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MessageId | null>(null);
  const prefix = useId();
  const keys = editableKeys(base);
  const { body: standard, invalid } = saveBody(base, draft);
  const fields = custom?.fields ?? NO_FIELDS;
  const [customDraft, setCustomDraft] = useState<CustomDraft>(() => draftOfCustom(fields, record.custom));
  const [customInvalid, setCustomInvalid] = useState<readonly string[]>([]);
  // Never sent: a key withheld on THIS record, or one the API has said is read-only (C4, C10).
  const skip = new Set([
    ...(custom?.readOnly ?? []),
    ...fields.filter((field) => isCustomWithheld(base.withheldFields, field.apiName)).map((field) => field.apiName),
  ]);
  const changed = customPatch(fields, base.custom, customDraft, skip);
  const body = changed.patch === null ? standard : { ...(standard ?? { version: base.version }), custom: changed.patch };

  // The definitions arrive after the sheet may have opened: seed the untouched keys from the record.
  useEffect(() => {
    setCustomDraft((typed) => rebaseCustomDraft(fields, undefined, base.custom, typed));
    // Only a change of the definitions re-seeds.
  }, [fields]);

  // A fresher record arrived (the re-read after a 409): rebase the edits onto it.
  useEffect(() => {
    if (record.version === base.version) return;
    const rebased = rebaseDraft(base, record, draft);
    setCustomDraft((typed) => rebaseCustomDraft(fields, base.custom, record.custom, typed));
    setBase(record);
    setDraft(rebased.form);
    setConflicts((held) => [...new Set([...held.filter((key) => rebased.edited.includes(key)), ...rebased.conflicts])]);
    // Only a new record starts a rebase; `base` and `draft` are read as they stand then.
  }, [record]);

  const set = (key: EditKey, value: string | boolean) => setDraft((current) => ({ ...current, [key]: value }));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving || offline) return;
    if (invalid.length > 0) {
      setError('record.error.invalid');
      return;
    }
    setCustomInvalid(changed.invalid);
    if (changed.invalid.length > 0) {
      setError(CUSTOM_INVALID);
      return;
    }
    if (body === null) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    // `body` carries the version of the record the draft is seeded from.
    const result = await onSave(body);
    setSaving(false);
    if (result.ok) {
      onClose();
      return;
    }
    // A refused custom value is its own translated message; a key told read-only stays so, unsent (C4).
    const refused = customErrorId(result.error);
    custom?.markReadOnly(notEditableKeys(result.error));
    setError(refused ?? writeErrorId(result.error.code));
  };

  const inputId = (key: EditKey) => `${prefix}-${key}`;
  const language = typeof draft.preferredLanguage === 'string' ? draft.preferredLanguage : '';
  const languages: string[] = [...LANGUAGE_CODES];
  if (language !== '' && languageLabel(language) === null) languages.push(language);

  const control = (key: EditKey) => {
    const value = draft[key];
    const common = { id: inputId(key), 'data-field-input': key, disabled: saving };
    if (key === 'whatsappOptIn') {
      return (
        <label htmlFor={inputId(key)} className="flex min-h-touch items-center gap-3 text-body-md">
          <input
            {...common}
            type="checkbox"
            checked={value === true}
            onChange={(event) => set(key, event.target.checked)}
            className="h-5 w-5 accent-primary"
          />
          {t.t(label(key))}
        </label>
      );
    }
    const text = typeof value === 'string' ? value : '';
    let input: React.ReactNode;
    if (key === 'preferredLanguage' || key === 'preferredChannel' || key === 'consentState') {
      const options =
        key === 'preferredLanguage'
          ? languages.map((code) => ({ code, label: languageLabel(code) }))
          : (key === 'preferredChannel' ? PreferredChannel.options : ConsentState.options).map((code) => ({
              code,
              label: `${key === 'preferredChannel' ? 'records.channel' : 'records.consent'}.${code}` as MessageId,
            }));
      input = (
        <select {...common} value={text} onChange={(event) => set(key, event.target.value)} className={`${FIELD} w-full`}>
          {key === 'consentState' ? null : <option value="">{t.t('records.cell.empty')}</option>}
          {options.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label === null ? option.code : t.t(option.label)}
            </option>
          ))}
        </select>
      );
    } else if (TEXT_KEYS.has(key)) {
      input = (
        <input
          {...common}
          value={text}
          maxLength={key === 'displayName' || key === 'givenNames' || key === 'familyName' ? 200 : undefined}
          autoComplete="off"
          aria-invalid={invalid.includes(key) ? true : undefined}
          aria-describedby={key === 'tags' ? `${inputId(key)}-hint` : undefined}
          onChange={(event) => set(key, event.target.value)}
          className={`${FIELD} w-full`}
        />
      );
    } else {
      input = (
        <textarea
          {...common}
          // The emails and phones typed here are the contact's own data, not UI copy.
          data-record-text=""
          value={text}
          rows={2}
          aria-describedby={`${inputId(key)}-hint`}
          onChange={(event) => set(key, event.target.value)}
          className={`${FIELD} w-full py-2`}
        />
      );
    }
    const hint = key === 'tags' ? 'record.sheet.tagsHint' : LIST_KEYS[key];
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId(key)} className="text-body-sm font-semibold">
          {t.t(label(key))}
        </label>
        {input}
        {hint === undefined ? null : (
          <span id={`${inputId(key)}-hint`} className="text-caption text-text-muted">
            {t.t(hint)}
          </span>
        )}
      </div>
    );
  };

  return (
    <Dialog
      title={t.t('record.sheet.title')}
      icon="edit"
      tone="info"
      closeLabel={t.t('record.sheet.close')}
      onClose={onClose}
      testId="contact-sheet"
      footer={
        <>
          <button type="button" onClick={onClose} className={QUIET_BUTTON}>
            {t.t('record.form.cancel')}
          </button>
          <button
            type="button"
            data-action="save-contact"
            data-requires-connection=""
            disabled={offline || saving}
            onClick={() => void submit()}
            className={PRIMARY_BUTTON}
          >
            {saving ? t.t('record.saving') : t.t('record.sheet.save')}
          </button>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        {error === null ? null : (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
            <Icon name="error" size="sm" />
            {t.t(error)}
          </p>
        )}
        {keys.map((key) => (
          <div key={key} className="flex flex-col gap-1">
            {control(key)}
            {conflicts.includes(key) ? (
              <p data-conflict="" className="flex items-start gap-1 text-caption font-semibold text-warning-text">
                <Icon name="info" size="sm" />
                {t.t('record.conflict.otherChange')}
              </p>
            ) : null}
          </div>
        ))}
        <CustomInputs
          t={t}
          fields={fields}
          draft={customDraft}
          withheldFields={base.withheldFields}
          readOnly={custom?.readOnly ?? NO_KEYS}
          disabled={saving}
          invalid={customInvalid}
          onChange={(key, value) => setCustomDraft((current) => ({ ...current, [key]: value }))}
        />
      </form>
    </Dialog>
  );
}
