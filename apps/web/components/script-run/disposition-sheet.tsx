'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { localToUtc, zoneName } from '../record/record-core';
import type { ScriptGraph } from '../../lib/script-graph';
import {
  completeScriptRun,
  listScriptRunDispositions,
  type CompleteBody,
  type RunDisposition,
  type RunOutcome,
  type ScriptRun,
} from '../../lib/script-runs-api';
import { suggestedDisposition } from './run-model';

/**
 * `P10/03` — completing the run: a MANDATORY live disposition (D-L88), read
 * from the run's own list, keyset paged on `nextCursor` with no count
 * (D-P13). At an end node its suggestion is pre-chosen; anywhere else nothing
 * is. A disposition that needs a note or a callback cannot be sent without
 * one, and the callback is typed as a local time and sent in UTC (R9).
 *
 * REFUSALS (R7, R8). Every refusal is a translated alert that keeps the sheet
 * and what was typed. `disposition_not_live` re-reads the list; `stale_write`
 * re-reads the run; neither is retried by itself. An answer that never
 * arrived cannot be known to have failed: the same body, revision included,
 * is sent again on the next press, and its 200 is the success it was.
 */

const MAX_AHEAD_MS = 366 * 86_400_000;

export interface Completion {
  readonly label: string;
  readonly dueAt?: string;
}

/** A callback time in the browser's zone, on a 24-hour clock. */
export function formatWhen(locale: string, iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try {
    return new Intl.DateTimeFormat(locale, options).format(at);
  } catch {
    return new Intl.DateTimeFormat('en', options).format(at);
  }
}

interface ListState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly rows: readonly RunDisposition[];
  readonly cursor: string | null;
  readonly loadingMore: boolean;
}

export function DispositionSheet({
  t,
  locale,
  run,
  graph,
  outcome,
  offline,
  reread,
  onClose,
  onCompleted,
}: {
  t: Translator;
  locale: string;
  run: ScriptRun;
  graph: ScriptGraph;
  outcome: RunOutcome;
  offline: boolean;
  reread: () => Promise<ScriptRun | null>;
  onClose: () => void;
  onCompleted: (run: ScriptRun, completion: Completion) => void;
}) {
  const [list, setList] = useState<ListState>({ phase: 'loading', rows: [], cursor: null, loadingMore: false });
  const [chosen, setChosen] = useState<string | null>(() => (outcome === 'completed' ? suggestedDisposition(run, graph) : null));
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');
  const [alert, setAlert] = useState<MessageId | null>(null);
  const [saving, setSaving] = useState(false);
  const [lost, setLost] = useState<CompleteBody | null>(null);
  const [generation, setGeneration] = useState(0);
  const title = useId();
  const noteId = useId();
  const whenId = useId();
  const heading = useRef<HTMLHeadingElement | null>(null);
  const suggested = outcome === 'completed' ? suggestedDisposition(run, graph) : null;

  const readPage = useCallback(
    async (cursor: string | null, rows: readonly RunDisposition[], signal?: AbortSignal) => {
      const result = await listScriptRunDispositions(run.id, cursor, signal);
      if (signal?.aborted === true) return;
      if (!result.ok) {
        setList((current) => ({ ...current, phase: current.rows.length === 0 ? 'error' : 'ready', loadingMore: false }));
        return;
      }
      const seen = new Set(rows.map((row) => row.id));
      setList({ phase: 'ready', rows: [...rows, ...result.value.data.filter((row) => !seen.has(row.id))], cursor: result.value.nextCursor, loadingMore: false });
    },
    [run.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    setList({ phase: 'loading', rows: [], cursor: null, loadingMore: false });
    void readPage(null, [], controller.signal);
    return () => controller.abort();
  }, [readPage, generation]);

  useEffect(() => {
    heading.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose, saving]);

  const disposition = list.rows.find((row) => row.id === chosen) ?? null;

  const save = async () => {
    if (saving) return;
    let body: CompleteBody;
    if (lost !== null) {
      body = lost;
    } else {
      if (disposition === null) {
        setAlert('scripting.run.sheet.chooseFirst');
        return;
      }
      const text = note.trim();
      if (disposition.noteRequired && text === '') {
        setAlert('scripting.run.sheet.noteMissing');
        return;
      }
      let dueAt: string | undefined;
      if (when !== '') {
        const utc = localToUtc(when);
        const at = utc === null ? Number.NaN : Date.parse(utc);
        if (utc === null || !(at > Date.now()) || at > Date.now() + MAX_AHEAD_MS) {
          setAlert('scripting.run.sheet.followUpInvalid');
          return;
        }
        dueAt = utc;
      } else if (disposition.followUpRequired) {
        setAlert('scripting.run.sheet.followUpMissing');
        return;
      }
      body = {
        revision: run.revision,
        outcome,
        dispositionId: disposition.id,
        ...(text === '' ? {} : { note: text }),
        ...(dueAt === undefined ? {} : { followUp: { dueAt } }),
      };
    }
    setSaving(true);
    setAlert(null);
    const result = await completeScriptRun(run.id, body);
    setSaving(false);
    if (result.ok) {
      const label = list.rows.find((row) => row.id === body.dispositionId)?.label ?? '';
      onCompleted(result.value, body.followUp === undefined ? { label } : { label, dueAt: body.followUp.dueAt });
      return;
    }
    const { code, status } = result.error;
    if (status === 0) {
      // The answer never arrived: it may have been saved. The next press sends this exact body.
      setLost(body);
      setAlert('scripting.run.sheet.lost');
      return;
    }
    setLost(null);
    setAlert(`scripting.error.${code}` as MessageId);
    if (code === 'disposition_not_live') {
      // Retired since the list was read: no longer a choice, and the list is read again.
      setChosen(null);
      setGeneration((value) => value + 1);
    } else if (status === 409) {
      await reread();
    }
  };

  const followUp = disposition?.followUpRequired === true;
  const locked = lost !== null;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-scrim md:items-center md:p-6">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        data-testid="disposition-sheet"
        data-outcome={outcome}
        className="flex max-h-screen w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-t-lg bg-surface p-4 shadow-3 md:rounded-lg"
      >
        <div className="flex items-start justify-between gap-2">
          <h2 id={title} ref={heading} tabIndex={-1} className="text-h4 focus-visible:outline-none">
            {t.t(outcome === 'completed' ? 'scripting.run.sheet.title.completed' : 'scripting.run.sheet.title.interrupted')}
          </h2>
          <button type="button" onClick={onClose} disabled={saving} aria-label={t.t('scripting.run.sheet.cancel')} className={QUIET_BUTTON}>
            <Icon name="close" size="sm" />
          </button>
        </div>
        {outcome === 'interrupted' ? <p className="text-body-sm text-text-2">{t.t('scripting.run.sheet.body.interrupted')}</p> : null}

        <div className="flex flex-col gap-2">
          <p id={`${title}-list`} className="text-body-sm font-semibold">
            {t.t('scripting.run.sheet.dispositions')}
          </p>
          {list.phase === 'loading' ? (
            <p role="status" className="text-body-sm text-text-2">
              {t.t('scripting.run.sheet.loading')}
            </p>
          ) : null}
          {list.phase === 'error' ? (
            <p role="alert" className="text-body-sm text-danger-text">
              {t.t('scripting.run.sheet.failed')}
            </p>
          ) : null}
          <div role="radiogroup" aria-labelledby={`${title}-list`} className="flex flex-col gap-2">
            {list.rows.map((row) => (
              <button
                key={row.id}
                type="button"
                role="radio"
                data-disposition={row.id}
                data-suggested={row.id === suggested ? 'true' : undefined}
                aria-checked={row.id === chosen}
                disabled={locked || saving}
                onClick={() => {
                  setChosen(row.id);
                  setAlert(null);
                }}
                className={`flex min-h-touch w-full flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                  row.id === chosen ? 'border-primary bg-primary-soft' : 'border-border-strong bg-surface'
                }`}
              >
                <Icon name={row.id === chosen ? 'check_circle' : 'radio_button_unchecked'} size="sm" />
                <span data-record-text="" className="font-semibold">
                  {row.label}
                </span>
                {row.id === suggested ? <span className="text-caption text-primary-text">{t.t('scripting.run.sheet.suggested')}</span> : null}
                {row.noteRequired ? <span className="text-caption text-text-muted">{t.t('scripting.run.sheet.noteRequired')}</span> : null}
                {row.followUpRequired ? <span className="text-caption text-text-muted">{t.t('scripting.run.sheet.followUpRequired')}</span> : null}
              </button>
            ))}
          </div>
          {list.cursor !== null && list.phase === 'ready' ? (
            <button
              type="button"
              data-testid="disposition-more"
              disabled={list.loadingMore}
              onClick={() => {
                setList((current) => ({ ...current, loadingMore: true }));
                void readPage(list.cursor, list.rows);
              }}
              className={`${QUIET_BUTTON} self-start disabled:opacity-60`}
            >
              {t.t('scripting.run.sheet.more')}
            </button>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={noteId} className="text-body-sm font-semibold">
            {t.t(disposition?.noteRequired === true ? 'scripting.run.sheet.note' : 'scripting.run.sheet.noteOptional')}
          </label>
          <textarea
            id={noteId}
            data-field-input="note"
            value={note}
            rows={3}
            maxLength={10_000}
            readOnly={locked}
            aria-required={disposition?.noteRequired === true}
            onChange={(event) => setNote(event.target.value)}
            className={`${FIELD} w-full py-2`}
          />
        </div>

        {followUp ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={whenId} className="text-body-sm font-semibold">
              {t.t('scripting.run.sheet.followUp')}
            </label>
            <input
              id={whenId}
              type="datetime-local"
              data-field-input="followUpAt"
              value={when}
              readOnly={locked}
              aria-required="true"
              onChange={(event) => setWhen(event.target.value)}
              className={`${FIELD} w-full`}
            />
            <p className="text-caption text-text-muted">{t.t('scripting.run.sheet.followUpHint', { zone: zoneName(locale) })}</p>
          </div>
        ) : null}

        {alert === null ? null : (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
            <Icon name="error" size="sm" />
            {t.t(alert)}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className={`${SECONDARY_BUTTON} disabled:opacity-60`}>
            {t.t('scripting.run.sheet.cancel')}
          </button>
          <button
            type="button"
            data-action="save-disposition"
            data-requires-connection=""
            disabled={offline || saving}
            aria-busy={saving}
            onClick={() => void save()}
            className={`${PRIMARY_BUTTON} disabled:opacity-60`}
          >
            {t.t(saving ? 'scripting.run.sheet.saving' : locked ? 'scripting.run.sheet.retry' : 'scripting.run.sheet.save')}
          </button>
        </div>
      </section>
    </div>
  );
}
