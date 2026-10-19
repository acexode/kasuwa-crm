'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { columnLetter, importIdFromUrl, isTerminal } from '../../lib/import-model';
import type { ImportJob } from '../../lib/imports-api';
import { formatCount, rowErrorId } from './import-text';

/**
 * A5 and A6: the run, then the report. One view, because they are one job
 * read again: while it is queued or running the counts are live (a polite
 * status region), and cancel is offered; when it ends the same counts are the
 * result.
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

export function JobView({
  t,
  locale,
  job,
  retrying,
  cancelling,
  onCancel,
  onLeave,
  leaveLabel,
  canLeave,
}: {
  t: Translator;
  locale: string;
  job: ImportJob;
  retrying: boolean;
  cancelling: boolean;
  onCancel: () => void;
  onLeave: () => void;
  leaveLabel: MessageId;
  /** Back to the landing: always for an import opened from the history, once it ended for the wizard's own. */
  canLeave: boolean;
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

  return (
    <section data-testid="import-job" data-import-status={job.status} aria-labelledby="import-job-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="import-job-title" className="text-h3">
          {t.t(ended ? 'import.report.title' : 'import.job.title')}
        </h2>
        <span className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-3 py-1 text-body-sm font-semibold text-text-2">
          <Icon name={ended ? (job.status === 'finished' ? 'check_circle' : 'info') : 'hourglass_top'} size="sm" />
          {t.t(`import.status.${job.status}` as MessageId)}
        </span>
      </div>

      <div role="status" data-testid="import-progress" aria-label={t.t('import.job.progress')}>
        <dl className="grid grid-cols-3 gap-2">
          {counts.map(([name, value]) => (
            <div key={name} className="flex min-w-0 flex-col rounded-lg border border-border bg-surface p-3">
              <dt className="text-caption font-bold text-text-muted">{t.t(`import.count.${name}` as MessageId)}</dt>
              <dd data-count={name} className="text-h3 tabular-nums">
                {formatCount(locale, value)}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {retrying && !ended ? (
        <p role="status" className="flex items-center gap-2 text-body-sm text-warning-text">
          <Icon name="network_check" size="sm" />
          {t.t('import.job.retrying')}
        </p>
      ) : null}

      {live ? (
        <div className="flex flex-col gap-2">
          {cancelling ? <p className="text-body-sm text-text-2">{t.t('import.job.cancelling')}</p> : null}
          <div>
            <button type="button" data-testid="import-cancel" disabled={cancelling} onClick={onCancel} className={SECONDARY_BUTTON}>
              {t.t('import.job.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {job.status === 'finished' ? (
        <p data-testid="import-result-note" className="text-body-sm text-text-2">
          {t.t('import.duplicates_skipped')} {t.t('import.no_restriction')}
        </p>
      ) : null}

      {ended && job.counts.created > 0 && contactsId !== undefined ? (
        <div>
          <Link data-testid="import-contacts-link" href={`/contacts?importId=${contactsId}`} prefetch={false} className={`${PRIMARY_BUTTON} inline-flex`}>
            {t.t('import.report.link')}
          </Link>
        </div>
      ) : null}

      {job.errors.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <h3 className="text-h4">{t.t('import.report.errors')}</h3>
          <ul className="flex flex-col rounded-lg border border-border bg-surface">
            {job.errors.slice(0, shown).map((error, position) => (
              <li
                key={position}
                data-row-error=""
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border p-3 text-body-sm last:border-b-0"
              >
                <span data-error-row="" className="font-semibold tabular-nums">
                  {t.t('import.report.row', { row: error.row })}
                </span>
                <span data-error-column="" className="min-w-0 break-words">
                  <ColumnName t={t} headers={job.headers} column={error.column} />
                </span>
                <span data-error-code={error.code} className="min-w-0 flex-1 text-text-2">
                  {t.t(rowErrorId(error.code))}
                </span>
              </li>
            ))}
          </ul>
          {job.errors.length > shown ? (
            <div>
              <button type="button" data-testid="import-errors-more" onClick={() => setShown((count) => count + MORE_ROWS)} className={SECONDARY_BUTTON}>
                {t.t('import.report.more')}
              </button>
            </div>
          ) : null}
          {job.errorsTruncated ? (
            <p data-testid="import-errors-truncated" className="text-body-sm text-text-2">
              {t.t('import.errors.truncated')}
            </p>
          ) : null}
        </div>
      )}

      {canLeave ? (
        <div>
          <button type="button" onClick={onLeave} className={SECONDARY_BUTTON}>
            {t.t(leaveLabel)}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** The column a row error names: by header, by position once the headers are erased, or the whole row. */
function ColumnName({ t, headers, column }: { t: Translator; headers: readonly string[] | null; column: number | null }) {
  if (column === null) return <>{t.t('import.whole_row')}</>;
  const header = headers?.[column];
  if (header !== undefined) {
    return (
      <b data-record-text="" dir="auto" className="font-semibold">
        {header}
      </b>
    );
  }
  return <>{t.t('import.report.position', { position: column + 1, letter: columnLetter(column) })}</>;
}
