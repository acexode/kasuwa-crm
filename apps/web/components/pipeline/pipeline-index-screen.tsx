'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createBundleTranslator, type MessageBundle } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { FOCUS } from '../records/list-classes';
import { appendPage } from '../records/list-model';
import { useOnline } from '../script-builder/use-online';
import { listPipelines, type PipelineError, type PipelineSummary } from '../../lib/pipelines-api';
import { errorMessage, pipelineHref } from './pipeline-model';

/**
 * `/pipelines` (T-0109, R1): the caller's pipelines by name, in served order,
 * each a link to its board, and the nav's Deals target. listPipelines decides
 * what the caller reaches; no id is printed. An empty list is its own state
 * (an administrator has not set one up), never an error.
 */
export function PipelineIndexScreen({
  locale,
  messages,
  locales,
  live,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
}) {
  const t = createBundleTranslator(locale, messages);
  const online = useOnline();
  const [rows, setRows] = useState<readonly PipelineSummary[]>([]);
  const [phase, setPhase] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [error, setError] = useState<PipelineError | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);

  useEffect(() => {
    sequence.current += 1;
    const mine = sequence.current;
    setPhase('loading');
    void listPipelines().then((result) => {
      if (mine !== sequence.current) return;
      if (result.ok) {
        setRows(result.value.data);
        setCursor(result.value.nextCursor);
        setPhase('loaded');
        return;
      }
      setError(result.error);
      setPhase('error');
    });
  }, [retry]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    void listPipelines(cursor).then((result) => {
      setLoadingMore(false);
      if (result.ok) {
        setRows((current) => appendPage(current, result.value.data));
        setCursor(result.value.nextCursor);
      }
    });
  }, [cursor, loadingMore]);

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="deals" live={live}>
      <div data-screen="P06/index" className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-h2">{t.t('pipeline.index.title')}</h1>
          <p className="text-body-sm text-text-2">{t.t('pipeline.index.intro')}</p>
        </div>
        {phase === 'loading' ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <span role="status" className="sr-only">
              {t.t('pipeline.index.loading')}
            </span>
            {[0, 1, 2].map((index) => (
              <span key={index} aria-hidden="true" className="h-12 rounded-md bg-surface-sunken" />
            ))}
          </div>
        ) : phase === 'error' ? (
          <div
            role="alert"
            data-testid="pipeline-index-error"
            className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-soft p-4 text-body-sm text-danger-text"
          >
            <p className="font-bold">{t.t('pipeline.index.error')}</p>
            <p>{t.t(errorMessage(error ?? { status: 0, code: 'network', details: [] }, 'read'))}</p>
            <button type="button" data-requires-connection="" disabled={!online} onClick={() => setRetry((current) => current + 1)} className={QUIET_BUTTON}>
              {t.t('records.retry')}
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div data-testid="pipeline-index-empty" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-6">
            <h2 className="text-h4 font-bold">{t.t('pipeline.index.empty.title')}</h2>
            <p className="text-body-sm text-text-2">{t.t('pipeline.index.empty.body')}</p>
          </div>
        ) : (
          <ul data-testid="pipeline-index" aria-label={t.t('pipeline.index.label')} className="flex flex-col gap-2">
            {rows.map((row) => {
              const href = pipelineHref(row.id);
              const inner = (
                <>
                  <Icon name="handshake" size="sm" className="text-text-muted" />
                  <span data-record-text="" className="min-w-0 flex-1 break-words">
                    {row.name}
                  </span>
                </>
              );
              const rowClass = 'flex min-h-touch items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 font-semibold text-text';
              return (
                <li key={row.id} data-pipeline={row.id}>
                  {href === null ? (
                    // Not a well-formed uuid: it names nothing this app can open (R15).
                    <span className={rowClass}>{inner}</span>
                  ) : (
                    <Link href={href} prefetch={false} className={`${rowClass} hover:bg-surface-sunken ${FOCUS}`}>
                      {inner}
                      <Icon name="chevron_right" size="sm" className="text-text-muted" />
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {phase === 'loaded' && cursor !== null ? (
          <div className="flex justify-center">
            <button
              type="button"
              data-requires-connection=""
              disabled={!online || loadingMore}
              onClick={loadMore}
              className={`${SECONDARY_BUTTON} disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {t.t(loadingMore ? 'records.loadingMore' : 'records.loadMore')}
            </button>
          </div>
        ) : null}
      </div>
    </CrmShell>
  );
}
