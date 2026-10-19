'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON } from '../auth/button-classes';
import { CHIP, CHIP_OFF, CHIP_ON, MENU_ROW } from '../records/list-classes';
import { isUuid, writeErrorId } from '../record/record-core';
import { hasDetail, listContacts, type RecordsResult } from '../../lib/records-api';
import { listAccounts } from '../../lib/accounts-api';
import { lookupRecords } from '../../lib/search-api';
import { planSearch } from '../../lib/search-query';
import { nameOrWithheld } from '../records/name';
import type { ComposeTarget, ComposedActivity, WrittenActivity } from '../../lib/activities-api';
import { CUSTOM_INVALID, customErrorId, namesUnknownField, notEditableKeys } from '../../lib/custom-values-core';
import type { CustomDraft } from '../../lib/custom-values-model';
import { LazyCustomInputs } from '../custom/lazy-inputs';
import { useCustomModel } from '../custom/use-custom-model';
import { useCustomFields, type ReadOnlyStore } from '../custom/use-custom-fields';
import { ActivityDialog } from './activity-dialog';
import { localToUtc, meetingRule, meetingRuleLabel } from './activities-model';

/**
 * P07/07 — compose a task or a meeting, for the caller (the owner is the
 * person composing, from `/auth/me`, so a meeting lands on their own
 * calendar), against ONE contact or account picked by name from a single
 * search over both.
 *
 * A meeting's times are checked here before anything is sent: both present,
 * the end after the start (equal is not after), at most 24 hours (exactly 24
 * is allowed). A bad one is a translated message under the field and the
 * request never goes. Times go on the wire in UTC, converted from the
 * browser's zone, which is the zone they were typed in.
 *
 * No attendees, location, reminders or external calendars (D-P22, D-P29).
 * Offline, Save is off and nothing is queued (D-P21); what was typed stays in
 * this component's memory only.
 */

type Kind = 'task' | 'meeting';
type Field = 'subject' | 'target' | 'dueAt' | 'startsAt' | 'endsAt';

type Picked = ComposeTarget & { readonly name: string };

const SEARCH_DEBOUNCE_MS = 300;
/** A number waits longer (as the search panel does): it is looked up once whole, not at every digit. */
const LOOKUP_DEBOUNCE_MS = 600;

function withoutField(errors: Partial<Record<Field, MessageId>>, field: Field): Partial<Record<Field, MessageId>> {
  return Object.fromEntries(Object.entries(errors).filter(([key]) => key !== field)) as Partial<Record<Field, MessageId>>;
}
const PICKER_LIMIT = 10;

export function ActivityComposer({
  t,
  offline,
  whoAmI,
  onSave,
  onClose,
  customFields = false,
  readOnlyStore,
}: {
  t: Translator;
  offline: boolean;
  /** Custom values are on in this process (read by the server page): offer the activity's own fields (T-0091). */
  customFields?: boolean;
  /** The screen's read-only keys, kept across the composer being closed and opened again. */
  readOnlyStore?: ReadOnlyStore;
  whoAmI: () => Promise<string | null>;
  onSave: (activity: ComposedActivity, owner: string) => Promise<RecordsResult<WrittenActivity>>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>('task');
  const [subject, setSubject] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly Picked[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [target, setTarget] = useState<Picked | null>(null);
  const [due, setDue] = useState('');
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, MessageId>>>({});
  const [alert, setAlert] = useState<MessageId | null>(null);
  const [saving, setSaving] = useState(false);
  const custom = useCustomFields('activity', customFields, readOnlyStore);
  const model = useCustomModel(custom.fields.length > 0);
  const [customDraft, setCustomDraft] = useState<CustomDraft>(() => model.draftOfCustom(custom.fields, undefined));
  const [customInvalid, setCustomInvalid] = useState<readonly string[]>([]);
  const searchSeq = useRef(0);
  const ids = {
    type: useId(),
    subject: useId(),
    target: useId(),
    targetHint: useId(),
    results: useId(),
    dueAt: useId(),
    startsAt: useId(),
    endsAt: useId(),
    owner: useId(),
    error: useId(),
  };

  // One search box over contacts AND accounts: listContacts and listAccounts
  // with `q`, side by side. Debounced; a stale answer is dropped, never drawn.
  useEffect(() => {
    const q = query.trim().slice(0, 100);
    searchSeq.current += 1;
    const seq = searchSeq.current;
    if (q === '') {
      setResults(null);
      setSearching(false);
      setSearchFailed(false);
      return undefined;
    }
    const plan = planSearch(q);
    if (plan.kind === 'refused' || plan.kind === 'keepTyping') {
      // A number being typed, or digits mixed into text: sent nowhere (R21, R27).
      setResults(null);
      setSearching(false);
      setSearchFailed(false);
      return undefined;
    }
    setSearching(true);
    if (plan.kind === 'lookup') {
      // A phone number or an email address is looked up whole, in a POST body. Accounts hold neither.
      const controller = new AbortController();
      const timer = window.setTimeout(() => {
        void lookupRecords(plan.field, plan.value, controller.signal).then((answer) => {
          if (seq !== searchSeq.current || controller.signal.aborted) return;
          setSearching(false);
          if (!answer.ok) {
            setSearchFailed(true);
            setResults(null);
            return;
          }
          setSearchFailed(false);
          setResults(
            answer.value
              .filter((group) => group.type === 'contact' || group.type === 'lead')
              .flatMap((group) => group.hits)
              .flatMap((hit): Picked[] =>
                hit.kind === 'person' && isUuid(hit.id) ? [{ kind: 'contact', id: hit.id, name: nameOrWithheld(t, hit.displayName) }] : [],
              )
              .filter((row, index, all) => all.findIndex((other) => other.id === row.id) === index),
          );
        });
      }, LOOKUP_DEBOUNCE_MS);
      return () => {
        window.clearTimeout(timer);
        controller.abort();
      };
    }
    const timer = window.setTimeout(() => {
      void Promise.all([listContacts({ q, limit: PICKER_LIMIT }), listAccounts({ q, limit: PICKER_LIMIT })]).then(
        ([contacts, accounts]) => {
          if (seq !== searchSeq.current) return;
          setSearching(false);
          if (!contacts.ok && !accounts.ok) {
            setSearchFailed(true);
            setResults(null);
            return;
          }
          setSearchFailed(false);
          const found: Picked[] = [
            ...(contacts.ok ? contacts.value.data : [])
              .filter((row) => isUuid(row.id))
              .map((row): Picked => ({ kind: 'contact', id: row.id, name: nameOrWithheld(t, row.displayName) })),
            ...(accounts.ok ? accounts.value.data : [])
              .filter((row) => isUuid(row.id))
              .map((row): Picked => ({ kind: 'account', id: row.id, name: row.name })),
          ];
          setResults(found);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // `t` is the bundle's translator, stable for the page's language: the box alone decides a search.
  }, [query]);

  const fieldProps = (field: Field, hint?: string) => ({
    'aria-invalid': errors[field] === undefined ? undefined : true,
    'aria-describedby': [errors[field] === undefined ? null : `${ids.error}-${field}`, hint ?? null].filter((id) => id !== null).join(' ') || undefined,
  });

  const fieldError = (field: Field) => {
    const message = errors[field];
    return message === undefined ? null : (
      <p id={`${ids.error}-${field}`} data-field-error={field} className="text-body-sm text-danger-text">
        {t.t(message)}
      </p>
    );
  };

  /** The activity the form describes, or the messages that stop it being sent. */
  const compose = (): { activity: ComposedActivity } | { errors: Partial<Record<Field, MessageId>> } => {
    const found: Partial<Record<Field, MessageId>> = {};
    if (subject.trim() === '') found.subject = 'activities.compose.error.subject';
    if (target === null) found.target = 'activities.compose.error.target';
    if (kind === 'task') {
      const dueAt = due === '' ? null : localToUtc(due);
      if (due !== '' && dueAt === null) found.dueAt = 'record.error.invalid';
      if (Object.keys(found).length > 0 || target === null) return { errors: found };
      return { activity: { type: 'task', subject, dueAt, target: { kind: target.kind, id: target.id } } };
    }
    const startsAt = starts === '' ? null : localToUtc(starts);
    const endsAt = ends === '' ? null : localToUtc(ends);
    if (starts !== '' && startsAt === null) found.startsAt = 'record.error.invalid';
    else if (ends !== '' && endsAt === null) found.endsAt = 'record.error.invalid';
    else {
      const rule = meetingRule(startsAt, endsAt);
      if (rule !== null) found[rule === 'required' && startsAt === null ? 'startsAt' : 'endsAt'] = meetingRuleLabel(rule);
    }
    if (Object.keys(found).length > 0 || target === null || startsAt === null || endsAt === null) return { errors: found };
    return { activity: { type: 'meeting', subject, startsAt, endsAt, target: { kind: target.kind, id: target.id } } };
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || offline) return;
    const outcome = compose();
    if ('errors' in outcome) {
      setErrors(outcome.errors);
      return;
    }
    const values = model.customValues(custom.fields, customDraft, custom.readOnly, t.locale);
    setCustomInvalid(values.invalid);
    if (values.invalid.length > 0) {
      setAlert(CUSTOM_INVALID);
      return;
    }
    setErrors({});
    setAlert(null);
    setSaving(true);
    const owner = await whoAmI();
    if (owner === null) {
      setSaving(false);
      setAlert('records.error.network');
      return;
    }
    const result = await onSave(values.patch === null ? outcome.activity : { ...outcome.activity, custom: values.patch }, owner);
    setSaving(false);
    if (result.ok) {
      onClose();
      return;
    }
    const { error } = result;
    // A refused custom value is its own translated message; a key told read-only is never sent again (C4).
    const refused = customErrorId(error);
    if (refused !== null) {
      {
      const told = notEditableKeys(error);
      custom.markReadOnly(told);
      setCustomDraft((typed) => model.resetKeys(custom.fields, undefined, typed, told));
      if (namesUnknownField(error)) custom.reload();
    }
      setAlert(refused);
      return;
    }
    if (hasDetail(error, 'field_not_editable')) {
      setAlert('activities.error.field_not_editable');
      return;
    }
    const rule = error.details?.find((detail) => ['invalid_range', 'too_long', 'required'].includes(detail.code));
    if (rule !== undefined && (rule.path === 'startsAt' || rule.path === 'endsAt')) {
      setErrors({ [rule.path]: `activities.meeting.error.${rule.code}` as MessageId });
      return;
    }
    setAlert(writeErrorId(error.code));
  };

  const timeInput = (field: 'dueAt' | 'startsAt' | 'endsAt', label: MessageId, value: string, set: (value: string) => void) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={ids[field]} className="text-body-sm font-semibold">
        {t.t(label)}
      </label>
      <input
        id={ids[field]}
        type="datetime-local"
        data-field-input={field}
        value={value}
        onChange={(event) => set(event.target.value)}
        className={FIELD}
        {...fieldProps(field)}
      />
      {fieldError(field)}
    </div>
  );

  return (
    <ActivityDialog testId="activity-composer" title={t.t('activities.compose.title')} closeLabel={t.t('record.sheet.close')} onClose={onClose}>
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        {alert === null ? null : (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
            <Icon name="error" size="sm" />
            {t.t(alert)}
          </p>
        )}
        <div role="group" aria-labelledby={ids.type} className="flex flex-col gap-1">
          <span id={ids.type} className="text-body-sm font-semibold">
            {t.t('activities.compose.type')}
          </span>
          <div className="flex flex-wrap gap-2">
            {(['task', 'meeting'] as const).map((option) => (
              <button
                key={option}
                type="button"
                data-activity-type={option}
                aria-pressed={kind === option}
                onClick={() => {
                  setKind(option);
                  setErrors({});
                }}
                className={`${CHIP} ${kind === option ? CHIP_ON : CHIP_OFF}`}
              >
                <Icon name={option === 'meeting' ? 'event' : 'task_alt'} size="sm" />
                {t.t(`record.activity.type.${option}` as MessageId)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.subject} className="text-body-sm font-semibold">
            {t.t('record.form.subject')}
          </label>
          <input
            id={ids.subject}
            data-field-input="subject"
            value={subject}
            maxLength={200}
            autoComplete="off"
            onChange={(event) => setSubject(event.target.value)}
            className={FIELD}
            {...fieldProps('subject')}
          />
          {fieldError('subject')}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={ids.target} className="text-body-sm font-semibold">
            {t.t('activities.compose.target')}
          </label>
          {target === null ? (
            <>
              <input
                id={ids.target}
                type="search"
                data-field-input="target"
                value={query}
                maxLength={100}
                autoComplete="off"
                aria-controls={ids.results}
                onChange={(event) => setQuery(event.target.value)}
                className={FIELD}
                {...fieldProps('target', ids.targetHint)}
              />
              <p id={ids.targetHint} className="text-caption text-text-muted">
                {t.t('activities.compose.target.hint')}
              </p>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
              <Icon name={target.kind === 'contact' ? 'person' : 'domain'} size="sm" />
              <span className="sr-only">{t.t('activities.compose.target.picked')}</span>
              <span data-record-text="" className="min-w-0 flex-1 truncate font-semibold">
                {target.name}
              </span>
              <button
                type="button"
                onClick={() => {
                  setTarget(null);
                  setQuery('');
                }}
                className={QUIET_BUTTON}
              >
                {t.t('activities.compose.target.change')}
              </button>
            </div>
          )}
          {fieldError('target')}
          <div id={ids.results} aria-live="polite">
            {target === null && searching ? <p className="text-caption text-text-2">{t.t('activities.compose.target.searching')}</p> : null}
            {target === null && !searching && searchFailed ? (
              <p className="text-caption text-danger-text">{t.t('activities.compose.target.failed')}</p>
            ) : null}
            {target === null && !searching && results !== null && results.length === 0 ? (
              <p className="text-caption text-text-2">{t.t('activities.compose.target.none')}</p>
            ) : null}
            {target === null && !searching && results !== null && results.length > 0 ? (
              <ul className="flex flex-col rounded-md border border-border bg-surface">
                {results.map((option) => (
                  <li key={`${option.kind}:${option.id}`}>
                    <button
                      type="button"
                      data-target-option={option.id}
                      data-target-type={option.kind}
                      onClick={() => {
                        setTarget(option);
                        setResults(null);
                        setErrors((current) => withoutField(current, 'target'));
                      }}
                      className={`${MENU_ROW} text-text`}
                    >
                      <Icon name={option.kind === 'contact' ? 'person' : 'domain'} size="sm" />
                      <span data-record-text="" className="min-w-0 flex-1 truncate">
                        {option.name}
                      </span>
                      <span className="text-caption text-text-2">
                        {t.t(option.kind === 'contact' ? 'activities.related.contact' : 'activities.related.account')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        {kind === 'task'
          ? timeInput('dueAt', 'record.activity.due', due, setDue)
          : (
            <div className="grid gap-3 sm:grid-cols-2">
              {timeInput('startsAt', 'activities.field.startsAt', starts, setStarts)}
              {timeInput('endsAt', 'activities.field.endsAt', ends, setEnds)}
            </div>
          )}

        <LazyCustomInputs
          t={t}
          fields={custom.fields}
          draft={customDraft}
          readOnly={custom.readOnly}
          disabled={saving}
          invalid={customInvalid}
          onChange={(key, value) => setCustomDraft((current) => ({ ...current, [key]: value }))}
        />

        <p id={ids.owner} className="text-caption text-text-muted">
          {t.t('activities.compose.owner')}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            data-action="save-activity"
            data-requires-connection=""
            aria-describedby={ids.owner}
            disabled={offline || saving}
            className={PRIMARY_BUTTON}
          >
            {saving ? t.t('record.saving') : t.t('record.form.save')}
          </button>
          <button type="button" onClick={onClose} className={QUIET_BUTTON}>
            {t.t('record.form.cancel')}
          </button>
        </div>
      </form>
    </ActivityDialog>
  );
}
