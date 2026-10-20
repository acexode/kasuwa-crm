'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { Panel, errorMessageId } from './panel';
import { useResource, type Resource } from './use-resource';
import { CARD, Notice, UnsavedBar } from './admin-ui';
import { Toggle } from './sla-tab';
import {
  getRetention,
  saveRetention,
  type RetentionExpiry,
  type ScreenError,
} from '../../lib/admin-api';
import {
  RETENTION_PERIOD_DAYS,
  UNSET_RETENTION,
  baselineOf,
  changedRetentionFields,
  draftOf,
  retentionWrite,
  shortenedFields,
  type PeriodField,
  type RetentionBaseline,
  type RetentionDraft,
} from './retention-model';

/**
 * `P02/B7` — retention periods, disposal method and legal hold.
 *
 * ---------------------------------------------------------------------------
 * THIS SCREEN DOES NOT CLAIM KASUWA ENFORCES RECORDING RETENTION. READ THIS
 * BEFORE CHANGING A WORD OF ITS COPY.
 *
 * D-T4 — "does the telephony platform already own recording retention?" — is
 * BLOCKED, and ADR-0003 says the telephony platform is not ours to build. So
 * the call-recording period on this screen may be a number Kasuwa records and
 * something else enforces. The retention model itself is M21, which is
 * unassigned.
 *
 * Every sentence here is therefore written as "what this programme's rule
 * says", never as "what Kasuwa will delete". `admin.ret.scope.note` states
 * plainly that recordings held by the telephony platform follow that
 * platform's own rule until the two are joined up. An admin who shortens a
 * recording period and believes the audio is gone, when it is not, has made a
 * promise to a regulator on our behalf that we cannot keep — and they would
 * have made it because a screen told them so.
 *
 * If a future copy change forces the claim, that is an escalation, not an
 * edit.
 * ---------------------------------------------------------------------------
 *
 * The write is the WHOLE document with its `version`, like the SLA tab, and a
 * `409 stale_write` re-reads rather than retrying. Any failure — a `501` from
 * the contract mock included — surfaces through `admin.error.<code>`, because
 * a save control that silently does nothing is worse than one that says what
 * happened.
 *
 * A programme with no stored policy answers `404` (D-L50). That is rendered
 * as "no rules saved yet" with every period unchosen — see `retention-model.ts`
 * for why nothing is pre-selected.
 *
 * `409 legal_hold_active` is its own message: the API refuses to turn a hold
 * off and shorten a period in one request. Two deliberate steps, two audit
 * rows.
 */

const PERIOD_ID: Readonly<Record<number, MessageId>> = {
  30: 'admin.ret.period.30d',
  90: 'admin.ret.period.90d',
  365: 'admin.ret.period.1y',
  730: 'admin.ret.period.2y',
  1095: 'admin.ret.period.3y',
  1825: 'admin.ret.period.5y',
  2555: 'admin.ret.period.7y',
  3650: 'admin.ret.period.10y',
};

interface PeriodRow {
  readonly field: PeriodField;
  readonly label: MessageId;
  readonly note: MessageId;
}

const PERIOD_ROWS: readonly PeriodRow[] = [
  {
    field: 'callRecordingsDays',
    label: 'admin.ret.row.recordings',
    note: 'admin.ret.row.recordings.note',
  },
  {
    field: 'messageTranscriptsDays',
    label: 'admin.ret.row.transcripts',
    note: 'admin.ret.row.transcripts.note',
  },
  {
    field: 'screenRecordingsDays',
    label: 'admin.ret.row.screen',
    note: 'admin.ret.row.screen.note',
  },
  { field: 'qaEvaluationsDays', label: 'admin.ret.row.qa', note: 'admin.ret.row.qa.note' },
];

const EXPIRY_OPTIONS: readonly RetentionExpiry[] = ['delete', 'anonymise'];

export function RetentionTab({
  t,
  programmeId,
  onDirtyChange,
  discardSignal,
}: {
  t: Translator;
  programmeId: string;
  onDirtyChange: (count: number) => void;
  discardSignal: number;
}) {
  const policy = useResource(
    useCallback((signal: AbortSignal) => getRetention(programmeId, signal), [programmeId]),
    [programmeId],
  );

  const [draft, setDraft] = useState<RetentionDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ScreenError | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // A 404 on a programme the page has already loaded is "no policy stored
  // yet" (D-L50), not a missing programme. See `retention-model.ts`.
  const unset = policy.error?.code === 'not_found';
  const stored = policy.data;
  const loaded = useMemo<RetentionBaseline | null>(
    () => (stored !== null ? baselineOf(stored) : unset ? UNSET_RETENTION : null),
    [stored, unset],
  );
  const view: Resource<RetentionBaseline> = {
    data: loaded,
    error: unset ? null : policy.error,
    loading: policy.loading,
    slow: policy.slow,
    reload: policy.reload,
  };

  useEffect(() => {
    if (loaded !== null) setDraft(draftOf(loaded));
  }, [loaded, discardSignal]);

  const changed = useMemo(
    () => (loaded === null || draft === null ? [] : changedRetentionFields(loaded, draft)),
    [loaded, draft],
  );

  const shortened = useMemo(
    () => (loaded === null || draft === null ? [] : shortenedFields(loaded, draft)),
    [loaded, draft],
  );

  /** Null while a period or the disposal method is still unchosen. */
  const write = loaded === null || draft === null ? null : retentionWrite(loaded, draft);

  useEffect(() => {
    onDirtyChange(changed.length);
  }, [changed.length, onDirtyChange]);

  const save = async () => {
    if (write === null) return;
    setSaving(true);
    setSaveError(null);
    const result = await saveRetention(programmeId, write);
    setSaving(false);
    if (result.ok) {
      setToast(t.t('admin.unsaved.saved'));
      policy.reload();
      return;
    }
    setSaveError(result.error);
    // A stale version is not a retry. Re-read so the person sees the rule a
    // colleague saved before deciding what to do with their own edit.
    if (result.error.code === 'stale_write') policy.reload();
  };

  const mark = (field: keyof RetentionDraft) =>
    changed.includes(field) ? 'border-accent bg-accent-soft' : 'border-border-strong bg-surface';

  return (
    <div data-screen="P02/B7" className="flex flex-col gap-6">
      {/* General guidance, not legal advice — the design's words, kept. */}
      <p
        role="note"
        data-testid="retention-notice"
        className="m-0 flex gap-2.5 rounded-lg bg-info-soft px-4 py-3.5 text-body-sm text-info-text"
      >
        <Icon name="info" size={20} className="shrink-0" />
        <span>
          {loaded === null || loaded.workspaceDefaultDays === null
            ? t.t('admin.ret.notice.noDefault')
            : t.t('admin.ret.notice', {
                days: t.t(PERIOD_ID[loaded.workspaceDefaultDays] ?? 'admin.prog.unknown'),
              })}
        </span>
      </p>

      {/* D-T4 is BLOCKED. See the note at the top of this file: this screen
          must not imply Kasuwa enforces retention on recordings it does not
          hold. The sentence is a permanent part of the screen, not a to-do. */}
      <p
        role="note"
        data-testid="retention-scope-note"
        className="-mt-3 m-0 flex gap-2.5 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-meta text-text-2"
      >
        <Icon name="help" size={18} className="shrink-0" />
        <span>{t.t('admin.ret.scope.note')}</span>
      </p>

      {unset ? (
        <div
          role="note"
          data-testid="retention-unset"
          className={`${CARD} flex flex-col gap-1 p-4`}
        >
          <b className="text-body-sm font-semibold">{t.t('admin.ret.unset.title')}</b>
          <span className="text-meta text-text-2">{t.t('admin.ret.unset.body')}</span>
        </div>
      ) : null}

      <Panel t={t} resource={view} skeletonRows={6}>
        {(data) =>
          draft === null ? null : (
            <section className={`${CARD} flex flex-col px-5 py-1`}>
              {PERIOD_ROWS.map((row) => (
                <div
                  key={row.field}
                  data-testid="retention-row"
                  data-retention-field={row.field}
                  className="flex flex-wrap items-center gap-4 border-b border-border py-3.5"
                >
                  <div className="flex min-w-60 flex-1 flex-col gap-0.5">
                    <b className="text-body-sm font-semibold">{t.t(row.label)}</b>
                    <span className="text-meta text-text-2">{t.t(row.note)}</span>
                    {shortened.includes(row.field) ? (
                      <span
                        data-testid="retention-shortened"
                        className="text-caption font-bold text-warning-text"
                      >
                        {t.t('admin.ret.shortened')}
                      </span>
                    ) : null}
                  </div>
                  <select
                    aria-label={t.t(row.label)}
                    data-testid={`retention-${row.field}`}
                    value={draft[row.field] === null ? '' : String(draft[row.field])}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        [row.field]: event.target.value === '' ? null : Number(event.target.value),
                      })
                    }
                    className={`h-control-md w-44 cursor-pointer rounded-md border ps-3 pe-2 text-body-sm text-text is-focus:field-focus ${mark(row.field)}`}
                  >
                    {/* Unchosen on a first write: a placeholder, never a
                        pre-selected period (see retention-model.ts). */}
                    {draft[row.field] === null ? (
                      <option value="" disabled>
                        {t.t('admin.ret.period.choose')}
                      </option>
                    ) : null}
                    {periodOptions(data[row.field]).map((days) => (
                      <option key={days} value={String(days)}>
                        {t.t(PERIOD_ID[days] ?? 'admin.ret.period.days', { days })}
                      </option>
                    ))}
                  </select>
                </div>
              ))}

              <fieldset className="m-0 flex flex-col gap-2.5 border-0 border-b border-solid border-border px-0 pb-4 pt-4">
                <legend className="float-left mb-2.5 w-full p-0 text-body-sm font-semibold">{t.t('admin.ret.onExpiry')}</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {EXPIRY_OPTIONS.map((option) => (
                    <label
                      key={option}
                      data-testid={`retention-expiry-${option}`}
                      className={`flex min-h-touch cursor-pointer items-start gap-2.5 rounded-10 border px-4 py-3.5 ${
                        draft.onExpiry === option
                          ? 'border-primary bg-primary-soft'
                          : 'border-border bg-surface is-hover:bg-surface-sunken'
                      }`}
                    >
                      <input
                        type="radio"
                        name="retention-on-expiry"
                        checked={draft.onExpiry === option}
                        onChange={() => setDraft({ ...draft, onExpiry: option })}
                        className="mt-0.5 size-4.5 shrink-0 accent-primary"
                      />
                      <span className="flex flex-col gap-0.5">
                        <b className="text-body-sm font-semibold">
                          {t.t(`admin.ret.onExpiry.${option}` as MessageId)}
                        </b>
                        <span className="text-meta text-text-2">
                          {t.t(`admin.ret.onExpiry.${option}.note` as MessageId)}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <Toggle
                label={t.t('admin.ret.redact')}
                note={t.t('admin.ret.redact.note')}
                checked={draft.redactSensitiveNumbersInTranscripts}
                changed={changed.includes('redactSensitiveNumbersInTranscripts')}
                changedLabel={t.t('admin.unsaved.changed')}
                testId="retention-redact"
                onChange={(value) =>
                  setDraft({ ...draft, redactSensitiveNumbersInTranscripts: value })
                }
              />

              <Toggle
                label={t.t('admin.ret.hold')}
                note={t.t('admin.ret.hold.note')}
                checked={draft.legalHold}
                changed={changed.includes('legalHold')}
                changedLabel={t.t('admin.unsaved.changed')}
                testId="retention-hold"
                onChange={(value) => setDraft({ ...draft, legalHold: value })}
              />
            </section>
          )
        }
      </Panel>

      {saveError === null ? null : (
        <Notice tone="danger" testId="retention-save-error" errorCode={saveError.code}>
          {t.t(errorMessageId(saveError))}
        </Notice>
      )}

      {toast === null ? null : (
        <Notice tone="success" testId="retention-toast">
          {toast}
        </Notice>
      )}

      {changed.length === 0 ? null : (
        <UnsavedBar
          label={t.t('admin.unsaved.region')}
          count={t.t('admin.unsaved.count', { count: changed.length })}
          detail={t.t('admin.ret.unsaved.detail', { count: changed.length })}
          discardLabel={t.t('admin.unsaved.discard')}
          saveLabel={t.t('admin.unsaved.save')}
          savingLabel={t.t('admin.unsaved.saving')}
          saving={saving}
          saveDisabled={write === null}
          onDiscard={() => {
            if (loaded !== null) setDraft(draftOf(loaded));
            setSaveError(null);
            setToast(t.t('admin.unsaved.discarded'));
          }}
          onSave={() => void save()}
        />
      )}
    </div>
  );
}

/**
 * The dropdown's options. A period the server already holds but the design
 * never listed is still rendered, or saving would silently change it to
 * whatever happened to be first.
 */
function periodOptions(stored: number | null): readonly number[] {
  return stored === null || RETENTION_PERIOD_DAYS.includes(stored)
    ? RETENTION_PERIOD_DAYS
    : [...RETENTION_PERIOD_DAYS, stored].sort((a, b) => a - b);
}
