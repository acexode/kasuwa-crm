'use client';

import { useId, useState, type FormEvent } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON } from '../auth/button-classes';
import { writeErrorId } from '../record/record-core';
import { hasDetail, type RecordsResult } from '../../lib/records-api';
import type { MyActivity, WrittenActivity } from '../../lib/activities-api';
import { ActivityDialog } from './activity-dialog';
import { Subject } from './activity-parts';
import {
  rebaseTimes,
  rescheduleBody,
  timeForm,
  timeKeys,
  versionOf,
  type TimeForm,
  type TimeKey,
} from './activities-model';

/**
 * Reschedule a task (its due time) or a meeting (its start, its end, or
 * both): the control for moving an event, so nobody has to drag (WCAG 2.2
 * SC 2.5.7). Each field is a `datetime-local` prefilled with the served time
 * in the browser's zone; a save sends `version` plus ONLY the times the
 * person changed, in UTC (D-L102).
 *
 * After a 409 the screen re-reads by itself and this form becomes the fresh
 * item with the person's edits on top: a time both people changed keeps what
 * was typed and says someone else changed it; one the person never touched
 * takes the fresh value and is never sent, after any number of 409s.
 * Nothing is optimistic: the calendar and the buckets move when the server
 * says so. A 403 `field_not_editable` is its own sentence and is not retried.
 */

const LABELS: Readonly<Record<TimeKey, MessageId>> = {
  dueAt: 'record.activity.due',
  startsAt: 'activities.field.startsAt',
  endsAt: 'activities.field.endsAt',
};

export function RescheduleForm({
  t,
  item,
  versions,
  offline,
  onSave,
  onStale,
  onClose,
}: {
  t: Translator;
  item: MyActivity;
  versions: Readonly<Record<string, number>>;
  offline: boolean;
  onSave: (id: string, body: Readonly<Record<string, string | number>>) => Promise<RecordsResult<WrittenActivity>>;
  /** Re-reads what is on screen and returns this activity as it now stands, or `null` if it is gone. */
  onStale: (id: string) => Promise<MyActivity | null>;
  onClose: () => void;
}) {
  const keys = timeKeys(item.type);
  const [seed, setSeed] = useState<TimeForm>(() => timeForm(item));
  const [typed, setTyped] = useState<TimeForm>(() => timeForm(item));
  const [version, setVersion] = useState(() => versionOf(item, versions));
  const [conflicts, setConflicts] = useState<readonly TimeKey[]>([]);
  const [fieldError, setFieldError] = useState<{ field: TimeKey; message: MessageId } | null>(null);
  const [alert, setAlert] = useState<MessageId | null>(null);
  const [saving, setSaving] = useState(false);
  const [gone, setGone] = useState(false);
  const ids = { error: useId(), hint: useId() };
  const inputIds: Record<TimeKey, string> = { dueAt: useId(), startsAt: useId(), endsAt: useId() };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || offline || gone) return;
    const outcome = rescheduleBody(item.type, version, seed, typed);
    if (outcome.kind === 'unchanged') {
      onClose();
      return;
    }
    if (outcome.kind === 'invalid') {
      setFieldError({ field: outcome.field, message: outcome.message });
      return;
    }
    setFieldError(null);
    setAlert(null);
    setSaving(true);
    const result = await onSave(item.id, outcome.body);
    if (result.ok) {
      setSaving(false);
      onClose();
      return;
    }
    const { error } = result;
    if (error.code === 'stale_write') {
      setAlert('activities.reschedule.stale');
      const fresh = await onStale(item.id);
      if (fresh === null) {
        setGone(true);
      } else {
        const rebased = rebaseTimes(seed, typed, timeForm(fresh), keys);
        setSeed(rebased.seed);
        setTyped(rebased.typed);
        setConflicts(rebased.conflicts);
        setVersion(versionOf(fresh, versions));
      }
      setSaving(false);
      return;
    }
    setSaving(false);
    if (hasDetail(error, 'field_not_editable')) {
      setAlert('activities.error.field_not_editable');
      return;
    }
    const rule = error.details?.find((detail) => ['invalid_range', 'too_long', 'required'].includes(detail.code));
    if (rule !== undefined && (keys as readonly string[]).includes(rule.path)) {
      setFieldError({ field: rule.path as TimeKey, message: `activities.meeting.error.${rule.code}` as MessageId });
      return;
    }
    setAlert(writeErrorId(error.code));
  };

  return (
    <ActivityDialog
      testId="reschedule-form"
      title={t.t('activities.reschedule.title')}
      closeLabel={t.t('record.sheet.close')}
      onClose={onClose}
    >
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <p className="text-body-md">
          <Subject t={t} item={item} className="font-semibold" />
        </p>
        {alert === null ? null : (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
            <Icon name="error" size="sm" />
            {t.t(alert)}
          </p>
        )}
        {gone ? (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-warning-soft p-3 text-body-sm text-warning-text">
            <Icon name="info" size="sm" />
            {t.t('activities.reschedule.gone')}
          </p>
        ) : null}
        {keys.map((key) => {
          const error = fieldError?.field === key ? fieldError.message : null;
          return (
            <div key={key} className="flex flex-col gap-1">
              <label htmlFor={inputIds[key]} className="text-body-sm font-semibold">
                {t.t(LABELS[key])}
              </label>
              <input
                id={inputIds[key]}
                type="datetime-local"
                data-field-input={key}
                value={typed[key] ?? ''}
                aria-invalid={error === null ? undefined : true}
                aria-describedby={error === null ? ids.hint : `${ids.error}-${key} ${ids.hint}`}
                onChange={(event) => {
                  const value = event.target.value;
                  setTyped((current) => ({ ...current, [key]: value }));
                }}
                className={FIELD}
              />
              {error === null ? null : (
                <p id={`${ids.error}-${key}`} data-field-error={key} className="text-body-sm text-danger-text">
                  {t.t(error)}
                </p>
              )}
              {conflicts.includes(key) ? (
                <p data-conflict={key} className="flex items-start gap-1 text-body-sm text-warning-text">
                  <Icon name="info" size="sm" />
                  {t.t('record.conflict.otherChange')}
                </p>
              ) : null}
            </div>
          );
        })}
        <p id={ids.hint} className="text-caption text-text-muted">
          {t.t('activities.reschedule.hint')}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            data-action="save-reschedule"
            data-requires-connection=""
            disabled={offline || saving || gone}
            className={PRIMARY_BUTTON}
          >
            {saving ? t.t('record.saving') : t.t('activities.reschedule.save')}
          </button>
          <button type="button" onClick={onClose} className={QUIET_BUTTON}>
            {t.t('record.form.cancel')}
          </button>
        </div>
      </form>
    </ActivityDialog>
  );
}
