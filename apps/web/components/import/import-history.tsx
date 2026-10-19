'use client';

import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { SECONDARY_BUTTON } from '../auth/button-classes';
import type { ImportHistory } from './use-import-history';
import type { ImportSummary, Programme } from '../../lib/imports-api';
import type { MessageId } from '@kasuwa/i18n/bundle';
import { formatCount, formatWhen } from './import-text';

/**
 * The past imports, as the API serves them (newest first, no total): the
 * file, the programme by name, when, the status in words and how many were
 * created. An import whose raw file was deleted has no filename any more
 * (D-L148), and says so in a neutral label: never "null", never a blank.
 * Each opens its run or report.
 *
 * A filename is a person's own and can name another person: drawn as text,
 * never parsed, and never put in a URL, a title or the console.
 */
export function ImportHistoryList({
  t,
  locale,
  history,
  programmes,
  canOpen,
  onOpen,
}: {
  t: Translator;
  locale: string;
  history: ImportHistory;
  programmes: readonly Programme[];
  /** False while an upload runs: opening another import would walk away from it (B1). */
  canOpen: boolean;
  onOpen: (importId: string) => void;
}) {
  return (
    <section data-testid="import-history" aria-labelledby="import-history-title" className="flex flex-col gap-3">
      <h2 id="import-history-title" className="text-h3">
        {t.t('import.history.title')}
      </h2>
      {history.phase === 'loading' ? (
        <div aria-busy="true">
          <span role="status" className="sr-only">
            {t.t('admin.loading')}
          </span>
          <div aria-hidden="true" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
            {Array.from({ length: 3 }, (_, index) => (
              <span key={index} className="h-10 rounded-sm bg-surface-sunken" />
            ))}
          </div>
        </div>
      ) : null}
      {history.phase === 'error' ? (
        <p role="alert" className="flex items-start gap-2 text-body-sm text-danger-text">
          <Icon name="error" size="sm" />
          {t.t('import.history.failed')}
        </p>
      ) : null}
      {history.phase === 'loaded' && history.rows.length === 0 ? <p className="text-body-md text-text-2">{t.t('import.history.empty')}</p> : null}
      {history.rows.length === 0 ? null : (
        <ul className="flex flex-col rounded-lg border border-border bg-surface">
          {history.rows.map((row) => (
            <HistoryRow key={row.id} t={t} locale={locale} row={row} programmes={programmes} canOpen={canOpen} onOpen={onOpen} />
          ))}
        </ul>
      )}
      {history.nextCursor === null ? null : (
        <div>
          <button type="button" disabled={history.loadingMore} onClick={history.loadMore} className={SECONDARY_BUTTON}>
            {t.t('import.history.more')}
          </button>
        </div>
      )}
    </section>
  );
}

function HistoryRow({
  t,
  locale,
  row,
  programmes,
  canOpen,
  onOpen,
}: {
  t: Translator;
  locale: string;
  row: ImportSummary;
  programmes: readonly Programme[];
  canOpen: boolean;
  onOpen: (importId: string) => void;
}) {
  const erased = row.filename === null;
  const programme = programmes.find((entry) => entry.id === row.programmeId);
  return (
    <li
      data-import-row={row.id}
      {...(erased ? { 'data-erased': 'true' } : {})}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border p-3 last:border-b-0"
    >
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
        {row.filename === null ? (
          <span className="text-body-md font-semibold text-text-2">{t.t('import.erased.file')}</span>
        ) : (
          <span data-record-text="" dir="auto" className="break-words text-body-md font-semibold">
            {row.filename}
          </span>
        )}
        <span className="flex flex-wrap items-center gap-x-2 text-body-sm text-text-2">
          {programme === undefined ? (
            t.t('import.programme.unknown')
          ) : (
            <span data-record-text="" dir="auto">
              {programme.name}
            </span>
          )}
          <time dateTime={row.createdAt}>{formatWhen(locale, row.createdAt)}</time>
        </span>
      </div>
      <span className="rounded-full bg-surface-sunken px-3 py-1 text-body-sm font-semibold text-text-2">{t.t(`import.status.${row.status}` as MessageId)}</span>
      <span className="text-body-sm text-text-2">
        <b className="tabular-nums text-text">{formatCount(locale, row.counts.created)}</b> {t.t('import.count.created')}
      </span>
      <button
        type="button"
        data-import-open=""
        disabled={!canOpen}
        aria-label={t.t('import.history.openLabel', { name: row.filename ?? t.t('import.erased.file') })}
        onClick={() => onOpen(row.id)}
        className={SECONDARY_BUTTON}
      >
        {t.t('import.history.open')}
      </button>
    </li>
  );
}
