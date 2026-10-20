'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Button } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { CARD, IconTile, StatTile, StatusPill, TABLE_CARD, TABLE_HEAD, type Tone } from '../data/parts';
import { columnLetter, importIdFromUrl, isTerminal, type ImportStatus } from '../../lib/import-model';
import type { ImportJob } from '../../lib/imports-api';
import { formatCount, formatWhen, rowErrorId } from './import-text';

/**
 * A6, the run, then the report. One view, because they are one job read
 * again: while it is queued or running the counts are live (a polite status
 * region), and cancel is offered; when it ends the same counts are the result.
 *
 * The export's card: a sync icon tile, the title and the file line, the bar,
 * three count tiles and the background note. There is no row total before the
 * run ends, so there is no percentage: while it runs the bar moves without
 * claiming a fraction, and it fills when the import ends.
 *
 * COUNTS AND { row, column, code } ROWS, NOTHING ELSE (D-L128 Q6). The API
 * serves no cell, so there is no value column, no "download the bad rows", no
 * undo and no "updated" count, and none is drawn. A row error names its row
 * as a spreadsheet shows it, its column by header name (or, once the file's
 * headers are erased, by position and spreadsheet letter), and its code in
 * words. A whole-row error has no column and says so. D-L151's note says
 * duplicates were skipped and no restriction was applied to contacts already
 * in Kasuwa.
 *
 * A header and a filename are user content: drawn as text (`data-record-text`).
 */

/** Rows drawn at first; the API serves at most 1,000, and a phone should not draw them all at once. */
const FIRST_ROWS = 100;
const MORE_ROWS = 200;

export const STATUS_TONE: Readonly<Record<ImportStatus, Tone>> = {
  awaiting_upload: 'neutral',
  reading_header: 'info',
  awaiting_mapping: 'info',
  queued: 'info',
  running: 'info',
  finished: 'success',
  failed: 'danger',
  rejected: 'danger',
  cancelled: 'neutral',
  expired: 'neutral',
};

export function JobView({
  t,
  locale,
  job,
  programmeName,
  retrying,
  cancelling,
  onCancel,
}: {
  t: Translator;
  locale: string;
  job: ImportJob;
  programmeName: string | null;
  retrying: boolean;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const [shown, setShown] = useState(FIRST_ROWS);
  const ended = isTerminal(job.status);
  const live = job.status === 'queued' || job.status === 'running';
  const contactsId = importIdFromUrl(job.id);
  const counts: readonly ['created' | 'skipped' | 'failed', number][] = [
    ['created', job.counts.created],
    ['skipped', job.counts.skipped],
    ['failed', job.counts.failed],
  ];
  const programme = programmeName ?? t.t('import.programme.unknown');

  return (
    <section data-testid="import-job" data-import-status={job.status} aria-labelledby="import-job-title" className="flex flex-col gap-5">
      <div className={CARD}>
        <div className="flex items-start gap-3">
          <IconTile icon={ended ? (job.status === 'finished' ? 'check_circle' : 'info') : 'sync'} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id="import-job-title" className="m-0 text-sheet-title">
              {t.t(ended ? 'import.report.into' : 'import.job.into', { programme })}
            </h2>
            <span className="flex flex-wrap items-center gap-x-1.5 text-meta text-text-2">
              {job.filename === null ? (
                <span>{t.t('import.erased.file')}</span>
              ) : (
                <span data-record-text="" dir="auto" className="min-w-0 break-all">
                  {job.filename}
                </span>
              )}
              <span aria-hidden="true">·</span>
              <time dateTime={job.createdAt}>{formatWhen(locale, job.createdAt)}</time>
            </span>
          </div>
          <StatusPill tone={STATUS_TONE[job.status]}>{t.t(`import.status.${job.status}` as MessageId)}</StatusPill>
        </div>

        <span aria-hidden="true" className="relative block h-2 overflow-hidden rounded-sm bg-surface-sunken">
          {ended ? (
            <span className={`absolute inset-0 ${job.status === 'finished' ? 'bg-primary' : 'bg-border-strong'}`} />
          ) : (
            <span data-k-shimmer="" className="absolute inset-y-0 start-0 w-1/3 animate-shimmer rounded-sm bg-primary" />
          )}
        </span>

        <div role="status" data-testid="import-progress" aria-label={t.t('import.job.progress')}>
          <dl className="m-0 grid grid-cols-3 gap-2.5">
            {counts.map(([name, value]) => (
              <StatTile
                key={name}
                sunken
                label={t.t(`import.count.${name}` as MessageId)}
                value={formatCount(locale, value)}
                attributes={{ 'data-count': name }}
              />
            ))}
          </dl>
        </div>

        {retrying && !ended ? (
          <p role="status" className="m-0 flex items-center gap-2 text-meta text-warning-text">
            <Icon name="network_check" size={18} />
            {t.t('import.job.retrying')}
          </p>
        ) : null}

        {live ? (
          <>
            <p className="m-0 flex items-start gap-2 text-meta text-text-2">
              <Icon name="notifications" size={18} className="shrink-0" />
              {t.t('import.job.background')}
            </p>
            {cancelling ? <p className="m-0 text-meta text-text-2">{t.t('import.job.cancelling')}</p> : null}
            <div>
              <Button icon="close" data-testid="import-cancel" disabled={cancelling} onClick={onCancel}>
                {t.t('import.job.cancel')}
              </Button>
            </div>
          </>
        ) : null}

        {job.status === 'finished' ? (
          <p data-testid="import-result-note" className="m-0 rounded-10 bg-info-soft px-4 py-3 text-body-sm text-info-text">
            {t.t('import.duplicates_skipped')} {t.t('import.no_restriction')}
          </p>
        ) : null}

        {ended && job.counts.created > 0 && contactsId !== undefined ? (
          <div>
            <Link
              data-testid="import-contacts-link"
              href={`/contacts?importId=${contactsId}`}
              prefetch={false}
              className="inline-flex h-control-base items-center gap-1.5 rounded-md border border-border-strong bg-surface px-3 text-label text-text is-hover:bg-surface-sunken is-focus-visible:ring-focus"
            >
              <Icon name="group" size={22} />
              {t.t('import.report.link')}
            </Link>
          </div>
        ) : null}
      </div>

      {job.errors.length === 0 ? null : (
        <div className="flex flex-col gap-3">
          <h3 className="m-0 text-sheet-title">{t.t('import.report.errors')}</h3>
          <div className={TABLE_CARD}>
            <div aria-hidden="true" className={`${TABLE_HEAD} hidden md:grid md:grid-cols-[120px_minmax(0,1fr)_minmax(0,2fr)]`}>
              <span>{t.t('import.report.col.row')}</span>
              <span>{t.t('import.report.col.column')}</span>
              <span>{t.t('import.report.col.problem')}</span>
            </div>
            <ul className="m-0 list-none p-0">
              {job.errors.slice(0, shown).map((error, position) => (
                <li
                  key={position}
                  data-row-error=""
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border px-4 py-3 text-body-sm last:border-b-0 md:grid md:min-h-11 md:grid-cols-[120px_minmax(0,1fr)_minmax(0,2fr)] md:items-center md:gap-3.5 md:py-2"
                >
                  <span data-error-row="" className="font-mono text-meta tabular-nums">
                    {t.t('import.report.row', { row: error.row })}
                  </span>
                  <span data-error-column="" className="min-w-0 break-words font-mono text-meta">
                    <ColumnName t={t} headers={job.headers} column={error.column} />
                  </span>
                  <span data-error-code={error.code} className="flex min-w-0 flex-1 items-center gap-1.5 text-text">
                    <Icon name="error" size={18} className="shrink-0 text-danger-text" />
                    {t.t(rowErrorId(error.code))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {job.errors.length > shown ? (
            <div>
              <Button data-testid="import-errors-more" onClick={() => setShown((count) => count + MORE_ROWS)}>
                {t.t('import.report.more')}
              </Button>
            </div>
          ) : null}
          {job.errorsTruncated ? (
            <p data-testid="import-errors-truncated" className="m-0 text-body-sm text-text-2">
              {t.t('import.errors.truncated')}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** The column a row error names: by header, by position once the headers are erased, or the whole row. */
function ColumnName({ t, headers, column }: { t: Translator; headers: readonly string[] | null; column: number | null }) {
  if (column === null) return <span className="font-sans">{t.t('import.whole_row')}</span>;
  const header = headers?.[column];
  if (header !== undefined) {
    return (
      <b data-record-text="" dir="auto" className="font-semibold">
        {header}
      </b>
    );
  }
  return <span className="font-sans">{t.t('import.report.position', { position: column + 1, letter: columnLetter(column) })}</span>;
}

/** An import opened from the history that has not been read yet, or could not be. */
export function RunLoading({ t, failed, onLeave }: { t: Translator; failed: boolean; onLeave: () => void }) {
  return (
    <section aria-busy={!failed} className={CARD}>
      {failed ? null : (
        <p role="status" className="m-0 text-body-sm text-text-2">
          {t.t('import.job.loading')}
        </p>
      )}
      {failed ? null : (
        <div aria-hidden="true" className="flex flex-col gap-2.5">
          <span className="h-11 w-2/3 rounded-md bg-surface-sunken" />
          <span className="h-2 rounded-sm bg-surface-sunken" />
          <span className="h-14 rounded-10 bg-surface-sunken" />
        </div>
      )}
      <div>
        <Button icon="arrow_back" onClick={onLeave} className="rtl:[&_.k-icon]:-scale-x-100">
          {t.t('import.job.back')}
        </Button>
      </div>
    </section>
  );
}
