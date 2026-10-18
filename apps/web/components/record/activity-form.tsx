'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON } from '../auth/button-classes';
import type { RecordsError, RecordsResult } from '../../lib/records-api';
import type { Activity, ActivityDraft, ActivityType } from '../../lib/contact-record-api';
import { localToUtc, writeErrorId } from './record-core';
import { CUSTOM_INVALID, customErrorId, notEditableKeys } from '../../lib/custom-values-core';
import type { CustomDraft } from '../../lib/custom-values-model';
import { LazyCustomInputs } from '../custom/lazy-inputs';
import { useCustomModel } from '../custom/use-custom-model';
import { useCustomFields } from '../custom/use-custom-fields';

/**
 * Log a note, a task or a call against the record on screen (D-P18): the
 * contact (T-0061) or the account (T-0063). The form knows nothing of which;
 * the screen's `onSave` adds the one target, so an account's note never names
 * a contact.
 *
 * The body is the contract's and no more: the type, the target, and the text
 * the user typed. An empty box is left out, never sent as `""`; a due time is
 * offered on a task only (anything else is `400 task_only`) and goes on the
 * wire in UTC, converted from the browser's zone, which is the zone the agent
 * typed it in.
 *
 * Saving is one press. The button is off while the request is in flight, so a
 * second tap on a slow link cannot log the same note twice. A refusal keeps
 * the form and what was typed, and says why in the reader's language — the
 * screen's own copy for the error code, never the server's English message.
 */
export function ActivityForm({
  t,
  type,
  offline,
  onSave,
  onClose,
  refusal,
  customFields = false,
}: {
  t: Translator;
  type: ActivityType;
  offline: boolean;
  onSave: (activity: ActivityDraft) => Promise<RecordsResult<Activity>>;
  onClose: (saved: boolean) => void;
  /** A record's own copy for a refusal it can name more exactly (the deal's refused link); `null` keeps the form's. */
  refusal?: (error: RecordsError) => MessageId | null;
  /** Custom values are on in this process (read by the server page): offer the activity's own fields (T-0091). */
  customFields?: boolean;
}) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [due, setDue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MessageId | null>(null);
  const custom = useCustomFields('activity', customFields);
  const model = useCustomModel(custom.fields.length > 0);
  const [customDraft, setCustomDraft] = useState<CustomDraft>({});
  const [customInvalid, setCustomInvalid] = useState<readonly string[]>([]);
  const subjectRef = useRef<HTMLInputElement>(null);
  const ids = { title: useId(), subject: useId(), body: useId(), due: useId(), hint: useId() };

  useEffect(() => {
    subjectRef.current?.focus();
  }, [type]);

  const empty = subject.trim() === '' && body.trim() === '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || empty || offline) return;
    let dueAt: string | undefined;
    if (type === 'task' && due !== '') {
      const utc = localToUtc(due);
      if (utc === null) {
        setError('record.error.invalid');
        return;
      }
      dueAt = utc;
    }
    // A create carries the filled values only: never a null, never an empty key.
    const values = model === null ? { patch: null, invalid: [] } : model.customValues(custom.fields, customDraft, custom.readOnly);
    setCustomInvalid(values.invalid);
    if (values.invalid.length > 0) {
      setError(CUSTOM_INVALID);
      return;
    }
    setSaving(true);
    setError(null);
    const result = await onSave({
      type,
      subject,
      body,
      ...(dueAt === undefined ? {} : { dueAt }),
      ...(values.patch === null ? {} : { custom: values.patch }),
    });
    setSaving(false);
    if (result.ok) {
      onClose(true);
    } else {
      const refused = customErrorId(result.error);
      if (refused !== null) custom.markReadOnly(notEditableKeys(result.error));
      setError(refused ?? refusal?.(result.error) ?? writeErrorId(result.error.code));
    }
  };

  return (
    <form
      data-testid="activity-form"
      data-activity-type={type}
      aria-labelledby={ids.title}
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-3 rounded-lg border border-border-strong bg-surface p-4"
    >
      <h3 id={ids.title} className="text-h5">
        {t.t(`record.log.title.${type}` as MessageId)}
      </h3>
      {error === null ? null : (
        <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
          <Icon name="error" size="sm" />
          {t.t(error)}
        </p>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.subject} className="text-body-sm font-semibold">
          {t.t('record.form.subject')}
        </label>
        <input
          id={ids.subject}
          ref={subjectRef}
          data-field-input="subject"
          value={subject}
          maxLength={200}
          autoComplete="off"
          onChange={(event) => setSubject(event.target.value)}
          className={FIELD}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.body} className="text-body-sm font-semibold">
          {t.t('record.form.body')}
        </label>
        <textarea
          id={ids.body}
          data-field-input="body"
          value={body}
          rows={3}
          maxLength={10_000}
          onChange={(event) => setBody(event.target.value)}
          className={`${FIELD} py-2`}
        />
      </div>
      {type === 'task' ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.due} className="text-body-sm font-semibold">
            {t.t('record.activity.due')}
          </label>
          <input
            id={ids.due}
            type="datetime-local"
            data-field-input="dueAt"
            value={due}
            onChange={(event) => setDue(event.target.value)}
            className={FIELD}
          />
        </div>
      ) : null}
      {model === null ? null : (
      <LazyCustomInputs
        t={t}
        fields={custom.fields}
        draft={customDraft}
        readOnly={custom.readOnly}
        disabled={saving}
        invalid={customInvalid}
        onChange={(key, value) => setCustomDraft((current) => ({ ...current, [key]: value }))}
      />
      )}
      <p id={ids.hint} className="text-caption text-text-muted">
        {t.t('record.form.hint')}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          data-action="save-activity"
          data-requires-connection=""
          aria-describedby={ids.hint}
          disabled={offline || saving || empty}
          className={PRIMARY_BUTTON}
        >
          {saving ? t.t('record.saving') : t.t('record.form.save')}
        </button>
        <button type="button" onClick={() => onClose(false)} className={QUIET_BUTTON}>
          {t.t('record.form.cancel')}
        </button>
      </div>
    </form>
  );
}
