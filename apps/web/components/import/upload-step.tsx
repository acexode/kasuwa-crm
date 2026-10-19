'use client';

import { useId, type ChangeEvent } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { MAX_FILE_BYTES } from '../../lib/import-model';
import type { UploadView } from '../../lib/import-upload';
import type { ProgrammeList } from './use-import-history';

/**
 * A and A1: the target programme, the file, and its upload.
 *
 * Choosing a file STARTS the upload: there is no second click. The size is
 * checked before anything is declared, so a file over 25 MiB is refused here
 * with the limit and advice (A1), not by the API. The file is never read by
 * this page (D-P21): the browser hands it to the network in pieces, and its
 * name is shown nowhere, not even here.
 *
 * Programmes are the session's, by name. With several there is no default:
 * an import into the wrong programme is the one mistake this step must not
 * make easy.
 */

const MIB = 1_048_576;

/** A percentage in the reader's own numerals and format. */
function percent(locale: string, value: number): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'percent' }).format(value / 100);
  } catch {
    return new Intl.NumberFormat('en', { style: 'percent' }).format(value / 100);
  }
}

export function UploadStep({
  t,
  locale,
  programmes,
  programmeId,
  tooLarge,
  upload,
  controls,
  onProgramme,
  onFile,
  onPause,
  onResume,
  onRetry,
  onCancel,
  onContinue,
}: {
  t: Translator;
  locale: string;
  programmes: ProgrammeList;
  programmeId: string;
  tooLarge: boolean;
  upload: UploadView | null;
  /** The uploader exists (the declaration was accepted): its controls can act. */
  controls: boolean;
  onProgramme: (id: string) => void;
  onFile: (file: File) => void;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const id = useId();
  const sizeMb = MAX_FILE_BYTES / MIB;
  const busy = upload !== null;
  const percentText = upload === null ? '' : percent(locale, upload.percent);

  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared at once so choosing the same file again fires again; the File itself is kept by the upload.
    event.target.value = '';
    if (file !== undefined) onFile(file);
  };

  return (
    <section className="flex flex-col gap-4" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="sr-only">
        {t.t('import.step.upload')}
      </h2>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-programme`} className="text-body-sm font-semibold">
          {t.t('import.programme.label')}
        </label>
        <select
          id={`${id}-programme`}
          data-testid="import-programme"
          value={programmeId}
          disabled={busy || programmes.phase === 'loading'}
          onChange={(event) => onProgramme(event.target.value)}
          className={`${FIELD} w-full md:max-w-md`}
        >
          <option value="">{t.t('import.programme.choose')}</option>
          {programmes.programmes.map((programme) => (
            <option key={programme.id} value={programme.id}>
              {programme.name}
            </option>
          ))}
        </select>
        {programmes.phase === 'error' ? (
          <p role="alert" className="text-body-sm text-danger-text">
            {t.t('import.programme.failed')}
          </p>
        ) : programmes.phase === 'loaded' && programmes.programmes.length === 0 ? (
          <p role="alert" className="text-body-sm text-danger-text">
            {t.t('import.programme.none')}
          </p>
        ) : (
          <p className="text-body-sm text-text-2">{t.t('import.programme.note')}</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <input
          id={`${id}-file`}
          type="file"
          data-testid="import-file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={picked}
          className="peer sr-only"
        />
        <label
          htmlFor={`${id}-file`}
          className={`${busy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} flex min-h-touch items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface p-4 text-body-md font-semibold text-text hover:bg-surface-sunken peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus md:max-w-md`}
        >
          <Icon name="upload_file" size="sm" />
          {t.t('import.file.choose')}
        </label>
        <p data-testid="import-limit" className="text-body-sm text-text-2">
          {t.t('import.limit', { size: sizeMb })}
        </p>
        <p className="text-body-sm text-text-2">{t.t('import.upload.note')}</p>
      </div>

      {tooLarge ? (
        <div data-testid="import-too-large" role="alert" className="flex flex-col gap-1 rounded-lg border border-danger bg-danger-soft p-3 text-body-sm text-danger-text">
          <b className="flex items-center gap-2">
            <Icon name="error" size="sm" />
            {t.t('import.too_large.title', { size: sizeMb })}
          </b>
          <span>{t.t('import.advice')}</span>
        </div>
      ) : null}

      {upload === null ? null : (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
          <div
            role="progressbar"
            data-testid="upload-progress"
            data-upload-state={upload.state}
            aria-label={t.t('import.upload.label')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={upload.percent}
            aria-valuetext={percentText}
            className="h-2 overflow-hidden rounded-full bg-surface-sunken"
          >
            <span className="block h-full bg-primary" style={{ inlineSize: `${upload.percent}%` }} />
          </div>
          {/* The live region says what the upload is doing, never how far: the number is the bar's own. */}
          <p role="status" className="text-body-sm text-text-2">
            {t.t(`import.upload.${upload.state}` as MessageId)}
          </p>
          <p aria-hidden="true" className="text-body-sm tabular-nums text-text-2">
            {percentText}
          </p>
          {controls && upload.state !== 'done' && !upload.completing ? (
            <div className="flex flex-wrap gap-2">
              {upload.state === 'uploading' ? (
                <button type="button" data-testid="upload-pause" onClick={onPause} className={SECONDARY_BUTTON}>
                  <Icon name="pause" size="sm" />
                  {t.t('import.upload.pause')}
                </button>
              ) : null}
              {upload.state === 'paused' ? (
                <button type="button" data-testid="upload-resume" onClick={onResume} className={SECONDARY_BUTTON}>
                  <Icon name="play_arrow" size="sm" />
                  {t.t('import.upload.resume')}
                </button>
              ) : null}
              {upload.state === 'failed' ? (
                <button type="button" data-testid="upload-retry" onClick={onRetry} className={SECONDARY_BUTTON}>
                  {t.t('import.upload.retry')}
                </button>
              ) : null}
              <button type="button" data-testid="upload-cancel" onClick={onCancel} className={QUIET_BUTTON}>
                <Icon name="close" size="sm" />
                {t.t('import.upload.cancel')}
              </button>
            </div>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" data-testid="import-continue" disabled={upload?.state !== 'done'} onClick={onContinue} className={PRIMARY_BUTTON}>
          {t.t('import.continue')}
        </button>
      </div>
    </section>
  );
}
