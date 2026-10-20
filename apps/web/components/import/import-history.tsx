'use client';

import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Button, EmptyState } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { StatusPill, TABLE_CARD } from '../data/parts';
import type { ImportHistory } from './use-import-history';
import type { ImportSummary, Programme } from '../../lib/imports-api';
import { formatCount, formatDay, formatWhen } from './import-text';
import { STATUS_TONE } from './job-view';

/**
 * The past imports, as the API serves them (newest first, no total), as the
 * export's bordered table: the file in mono, "Contacts · programme", when, how
 * many were created, the status pill and Open. An import whose raw file was
 * deleted has no filename any more (D-L148), and says so in a neutral label:
 * never "null", never a blank. Each opens its run or report.
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
      <h2 id="import-history-title" className="m-0 text-sheet-title">
        {t.t('import.history.title')}
      </h2>
      {history.phase === 'loading' ? (
        <div aria-busy="true">
          <span role="status" className="sr-only">
            {t.t('admin.loading')}
          </span>
          <div aria-hidden="true" className={`${TABLE_CARD} flex flex-col`}>
            {Array.from({ length: 3 }, (_, index) => (
              <span key={index} className="flex h-[52px] items-center gap-4 border-b border-border px-4 last:border-b-0">
                <span className="h-3.5 w-40 rounded-sm bg-surface-sunken" />
                <span className="h-3.5 flex-1 rounded-sm bg-surface-sunken" />
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {history.phase === 'error' ? (
        <p role="alert" className="m-0 flex items-start gap-2 text-body-sm text-danger-text">
          <Icon name="error" size={20} />
          {t.t('import.history.failed')}
        </p>
      ) : null}
      {history.phase === 'loaded' && history.rows.length === 0 ? (
        <div className={`${TABLE_CARD} px-5 py-6`}>
          <EmptyState icon="history" tone="neutral" headingLevel={3} title={t.t('import.history.empty')} body={t.t('import.history.empty.body')} />
        </div>
      ) : null}
      {history.rows.length === 0 ? null : (
        <ul className={`${TABLE_CARD} m-0 list-none p-0`}>
          {history.rows.map((row) => (
            <HistoryRow key={row.id} t={t} locale={locale} row={row} programmes={programmes} canOpen={canOpen} onOpen={onOpen} />
          ))}
        </ul>
      )}
      {history.nextCursor === null ? null : (
        <div>
          <Button disabled={history.loadingMore} onClick={history.loadMore}>
            {t.t('import.history.more')}
          </Button>
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
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border px-4 py-3 text-body-sm last:border-b-0 lg:grid lg:min-h-[52px] lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_minmax(0,0.9fr)_minmax(0,1fr)_auto_auto] lg:py-2"
    >
      {row.filename === null ? (
        <span className="basis-full text-body-sm font-semibold text-text-2 lg:basis-auto">{t.t('import.erased.file')}</span>
      ) : (
        <span data-record-text="" dir="auto" className="min-w-0 basis-full break-all font-mono text-meta lg:basis-auto lg:truncate">
          {row.filename}
        </span>
      )}
      <span className="min-w-0 truncate text-text-2 lg:text-text">
        {t.t('import.object.contacts')}
        {' · '}
        {programme === undefined ? (
          t.t('import.programme.unknown')
        ) : (
          <span data-record-text="" dir="auto">
            {programme.name}
          </span>
        )}
      </span>
      <time dateTime={row.createdAt} title={formatWhen(locale, row.createdAt)} className="text-text-2">
        {formatDay(locale, row.createdAt)}
      </time>
      <span className="text-text">
        <b className="font-semibold tabular-nums">{formatCount(locale, row.counts.created)}</b> {t.t('import.count.created.lower')}
      </span>
      <StatusPill tone={STATUS_TONE[row.status]}>{t.t(`import.status.${row.status}` as MessageId)}</StatusPill>
      <Button
        size="compact"
        data-import-open=""
        disabled={!canOpen}
        aria-label={t.t('import.history.openLabel', { name: row.filename ?? t.t('import.erased.file') })}
        onClick={() => onOpen(row.id)}
        className="ms-auto lg:ms-0"
      >
        {t.t('import.history.open')}
      </Button>
    </li>
  );
}
