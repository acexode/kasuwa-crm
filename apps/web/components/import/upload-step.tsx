'use client';

import { useId, useState, type ChangeEvent, type DragEvent } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CARD, CARD_TITLE, IconTile, NativeSelect, RadioCard, SmallIconButton } from '../data/parts';
import { MAX_FILE_BYTES } from '../../lib/import-model';
import type { UploadView } from '../../lib/import-upload';
import type { ProgrammeList } from './use-import-history';
import { numberingLocale } from '../../lib/numbering';

/**
 * A and A1: the file, what is in it, and the programme it goes into — the
 * export's two cards, "1. Choose a file" and "2. What's in the file?".
 *
 * Choosing (or dropping) a file STARTS the upload: there is no second click.
 * The size is checked before anything is declared, so a file over 25 MiB is
 * refused here with the limit and advice (A1), not by the API. The file is
 * never read by this page (D-P21): the browser hands it to the network in
 * pieces. Its name and size are the person's own, drawn back to them.
 *
 * WHAT IS IN THE FILE is contacts, and only contacts (D-L146). In the Data
 * management area the design's other objects are drawn too, disabled and
 * saying they are not available yet (D-L194); at `/contacts/import` only the
 * one card is drawn.
 *
 * Programmes are the session's, by name. With several there is no default:
 * an import into the wrong programme is the one mistake this step must not
 * make easy.
 */

const MIB = 1_048_576;

export interface PickedFile {
  readonly name: string;
  readonly size: number;
}

function formatter(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(numberingLocale(locale), options);
  } catch {
    return new Intl.NumberFormat('en', options);
  }
}

/** A percentage in the reader's own numerals and format. */
function percent(locale: string, value: number): string {
  return formatter(locale, { style: 'percent' }).format(value / 100);
}

/** Bytes as megabytes, one decimal, in the reader's format ("38.2 MB"). */
export function megabytes(locale: string, bytes: number): string {
  return formatter(locale, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 }).format(bytes / 1_000_000);
}

const OTHER_OBJECTS = [
  ['accounts', 'apartment'],
  ['leads', 'person_add'],
  ['tickets', 'confirmation_number'],
] as const;

export function UploadStep({
  t,
  locale,
  designed,
  programmes,
  programmeId,
  tooLarge,
  picked,
  upload,
  controls,
  onProgramme,
  onFile,
  onPause,
  onResume,
  onRetry,
  onCancel,
}: {
  t: Translator;
  locale: string;
  /** The Data management frame: the design's disabled objects are drawn too. */
  designed: boolean;
  migrationHref: string | null;
  programmes: ProgrammeList;
  programmeId: string;
  tooLarge: boolean;
  picked: PickedFile | null;
  upload: UploadView | null;
  /** The uploader exists (the declaration was accepted): its controls can act. */
  controls: boolean;
  onProgramme: (id: string) => void;
  onFile: (file: File) => void;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const sizeMb = MAX_FILE_BYTES / MIB;
  const busy = upload !== null;
  const [over, setOver] = useState(false);
  const percentText = upload === null ? '' : percent(locale, upload.percent);

  const picked_ = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared at once so choosing the same file again fires again; the File itself is kept by the upload.
    event.target.value = '';
    if (file !== undefined) onFile(file);
  };

  const dropped = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setOver(false);
    if (busy) return;
    const file = event.dataTransfer.files[0];
    if (file !== undefined) onFile(file);
  };

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <section className={CARD} aria-labelledby={`${id}-file-title`}>
        <h2 id={`${id}-file-title`} className={CARD_TITLE}>
          {t.t('import.upload.cardTitle')}
        </h2>

        <input
          id={`${id}-file`}
          type="file"
          data-testid="import-file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={picked_}
          className="peer sr-only"
        />
        <label
          htmlFor={`${id}-file`}
          onDragOver={(event) => {
            event.preventDefault();
            if (!busy) setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={dropped}
          className={`flex flex-col items-center gap-1.5 rounded-lg border-2 border-dashed px-5 py-6.5 text-center peer-focus-visible:ring-focus ${
            busy ? 'cursor-not-allowed border-border bg-surface-sunken text-text-muted' : over ? 'cursor-copy border-primary bg-primary-soft text-text' : 'cursor-pointer border-border-strong bg-surface-sunken text-text'
          }`}
        >
          <Icon name="upload_file" size={32} className={busy ? '' : 'text-primary-text'} />
          <b className="text-label font-bold">{t.t('import.drop.title')}</b>
          <span className={`text-body-sm font-semibold ${busy ? '' : 'text-primary-text'}`}>{t.t('import.drop.choose')}</span>
          <span data-testid="import-limit" className="text-caption font-normal text-text-muted">
            {t.t('import.limit', { size: sizeMb })}
          </span>
        </label>

        {tooLarge ? (
          <div data-testid="import-too-large" role="alert" className="flex gap-3 rounded-lg bg-danger-soft p-4 text-danger-text">
            <Icon name="error" size={20} className="mt-px shrink-0" />
            <div className="flex min-w-0 flex-col gap-1">
              <b className="text-body-sm font-bold">
                {picked === null
                  ? t.t('import.too_large.title', { size: sizeMb })
                  : t.t('import.too_large.named', { name: picked.name, size: megabytes(locale, picked.size), limit: sizeMb })}
              </b>
              <span className="text-body-sm text-text">{t.t('import.advice')}</span>
            </div>
          </div>
        ) : null}

        {upload === null ? null : (
          <div className="flex gap-3 rounded-10 border border-border p-3.5">
            <IconTile icon="upload" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              {picked === null ? null : (
                <div className="flex min-w-0 items-baseline gap-2">
                  <b data-record-text="" dir="auto" className="truncate text-body-sm font-bold">
                    {picked.name}
                  </b>
                  <span className="whitespace-nowrap text-caption font-normal text-text-muted">{megabytes(locale, picked.size)}</span>
                </div>
              )}
              <div
                role="progressbar"
                data-testid="upload-progress"
                data-upload-state={upload.state}
                aria-label={t.t('import.upload.label')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={upload.percent}
                aria-valuetext={percentText}
                className="relative h-2 overflow-hidden rounded-sm bg-surface-sunken"
              >
                <span
                  className={`absolute inset-y-0 start-0 rounded-sm ${upload.state === 'failed' ? 'bg-danger' : upload.state === 'done' ? 'bg-success' : 'bg-primary'}`}
                  style={{ inlineSize: `${upload.percent}%` }}
                />
              </div>
              <span aria-hidden="true" className="text-caption font-normal tabular-nums text-text-2">
                {picked === null
                  ? percentText
                  : t.t('import.upload.progress', {
                      percent: percentText,
                      done: megabytes(locale, (picked.size * upload.percent) / 100),
                      total: megabytes(locale, picked.size),
                    })}
              </span>
              {/* The live region says what the upload is doing, never how far: the number is the bar's own. */}
              <span role="status" className={`text-caption font-semibold ${upload.state === 'failed' ? 'text-danger-text' : upload.state === 'done' ? 'text-success-text' : 'text-text-2'}`}>
                {t.t(`import.upload.${upload.state}` as MessageId)}
              </span>
            </div>
            {controls && upload.state !== 'done' && !upload.completing ? (
              <div className="flex items-start gap-1">
                {upload.state === 'uploading' ? <SmallIconButton icon="pause" label={t.t('import.upload.pause')} testId="upload-pause" onClick={onPause} /> : null}
                {upload.state === 'paused' ? <SmallIconButton icon="play_arrow" label={t.t('import.upload.resume')} testId="upload-resume" onClick={onResume} /> : null}
                {upload.state === 'failed' ? <SmallIconButton icon="refresh" label={t.t('import.upload.retry')} testId="upload-retry" onClick={onRetry} /> : null}
                <SmallIconButton icon="close" label={t.t('import.upload.cancel')} testId="upload-cancel" bordered={false} onClick={onCancel} />
              </div>
            ) : null}
          </div>
        )}

        <span className="flex gap-2 text-caption font-normal text-text-2">
          <Icon name="network_check" size={18} className="shrink-0" />
          {t.t('import.upload.note')}
        </span>
      </section>

      <section className={`${CARD} gap-3`} aria-labelledby={`${id}-object-title`}>
        <h2 id={`${id}-object-title`} className={CARD_TITLE}>
          {t.t('import.object.title')}
        </h2>
        <div role="radiogroup" aria-labelledby={`${id}-object-title`} className="flex flex-col gap-1.5">
          <RadioCard name={`${id}-object`} checked icon="person" title={t.t('import.object.contacts')} body={t.t('import.object.contacts.body')} />
          {designed
            ? OTHER_OBJECTS.map(([object, icon]) => (
                <RadioCard
                  key={object}
                  name={`${id}-object`}
                  checked={false}
                  disabled
                  icon={icon}
                  title={t.t(`import.object.${object}` as MessageId)}
                  body={t.t('records.nav.soon')}
                />
              ))
            : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-programme`} className="text-meta font-semibold">
            {t.t('import.programme.label')}
          </label>
          <NativeSelect
            id={`${id}-programme`}
            data-testid="import-programme"
            value={programmeId}
            disabled={busy || programmes.phase === 'loading'}
            onChange={(event) => onProgramme(event.target.value)}
          >
            <option value="">{t.t('import.programme.choose')}</option>
            {programmes.programmes.map((programme) => (
              <option key={programme.id} value={programme.id}>
                {programme.name}
              </option>
            ))}
          </NativeSelect>
          {programmes.phase === 'error' ? (
            <p role="alert" className="m-0 text-caption font-normal text-danger-text">
              {t.t('import.programme.failed')}
            </p>
          ) : programmes.phase === 'loaded' && programmes.programmes.length === 0 ? (
            <p role="alert" className="m-0 text-caption font-normal text-danger-text">
              {t.t('import.programme.none')}
            </p>
          ) : (
            <p className="m-0 text-caption font-normal text-text-muted">{t.t('import.programme.note')}</p>
          )}
        </div>
      </section>
    </div>
  );
}
