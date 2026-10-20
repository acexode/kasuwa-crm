'use client';

import type { Translator } from '@kasuwa/i18n/bundle';
import { Button, EmptyState } from '@kasuwa/ui/components';
import { StatusPill, TABLE_CARD } from '../data/parts';
import type { ContactMerge } from '../../lib/duplicates-api';
import { mergeState } from './duplicates-model';
import { Icon } from '../icon';
import { PersonName, Skeleton, When } from './duplicates-parts';
import { MoreButton } from './sets-list';
import type { MergeHistory } from './use-merge-history';

/**
 * The merges history (D-P27, Phase 2's recycle bin): each merge as served,
 * newest first, with both names (or the withheld label), when it was made and
 * what can still be done. A merged-away contact is never linked: it is the one
 * 404, and the contract has no "merged into" pointer.
 *
 * OPEN offers Undo, also for another user's merge: controls are shown and the
 * API's 403 is the gate (D-L84). UNDONE says so, and says when the survivor
 * kept edits made since. EXPIRED says "undo expired" and offers nothing.
 */
export function HistoryList({ t, locale, history }: { t: Translator; locale: string; history: MergeHistory }) {
  const now = Date.now();
  return (
    <section data-testid="merges-history" aria-labelledby="merges-history-title" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="merges-history-title" className="m-0 text-sheet-title">
          {t.t('duplicates.history.title')}
        </h2>
        <p className="m-0 text-body-sm text-text-2">{t.t('duplicates.history.note')}</p>
      </div>
      {history.phase === 'loading' ? <Skeleton t={t} label="duplicates.history.loading" /> : null}
      {history.phase === 'error' ? (
        <p role="alert" data-testid="merges-failed" className="text-body-sm text-danger-text">
          {t.t('duplicates.history.failed')}
        </p>
      ) : null}
      {history.phase === 'loaded' && history.rows.length === 0 ? (
        <div data-testid="merges-empty" className={`${TABLE_CARD} px-5 py-6`}>
          <EmptyState icon="history" tone="neutral" headingLevel={3} title={t.t('duplicates.history.empty')} body={t.t('duplicates.history.empty.body')} />
        </div>
      ) : null}
      {history.rows.length === 0 ? null : (
        <ul className={`${TABLE_CARD} m-0 list-none p-0`}>
          {history.rows.map((merge) => (
            <HistoryRow key={merge.id} t={t} locale={locale} merge={merge} state={mergeState(merge, now, history.expired)} history={history} />
          ))}
        </ul>
      )}
      {history.nextCursor === null ? null : <MoreButton t={t} testId="merges-more" loading={history.loadingMore} disabled={false} onClick={history.more} />}
    </section>
  );
}

function HistoryRow({ t, locale, merge, state, history }: { t: Translator; locale: string; merge: ContactMerge; state: ReturnType<typeof mergeState>; history: MergeHistory }) {
  const refused = history.closed.has(merge.id);
  return (
    <li data-merge-row={merge.id} data-merge-state={state} className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-4 py-3 last:border-b-0">
      <span aria-hidden="true" className="flex size-[34px] shrink-0 items-center justify-center rounded-md bg-surface-sunken text-text-2">
        <Icon name="join" size={18} />
      </span>
      <dl className="m-0 grid min-w-0 flex-1 basis-64 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-body-sm">
        <dt className="text-text-2">{t.t('duplicates.role.kept')}</dt>
        <dd className="min-w-0">
          <PersonName t={t} name={merge.survivor.displayName} />
        </dd>
        <dt className="text-text-2">{t.t('duplicates.role.merged')}</dt>
        <dd className="min-w-0">
          <PersonName t={t} name={merge.merged.displayName} />
        </dd>
        <dt className="text-text-2">{t.t('duplicates.history.mergedAt')}</dt>
        <dd>
          <When locale={locale} iso={merge.mergedAt} />
        </dd>
      </dl>
      {state === 'open' ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-body-sm text-text-2">
            {t.t('duplicates.undoUntil')} <When locale={locale} iso={merge.undoUntil} />
          </span>
          {refused ? (
            <span className="text-body-sm text-text-2">{t.t('duplicates.undo.unavailable')}</span>
          ) : (
            <Button size="compact" icon="undo" data-merge-undo="" disabled={history.undoing !== null} onClick={() => history.undo(merge.id)}>
              {t.t('duplicates.undo')}
            </Button>
          )}
        </div>
      ) : null}
      {state === 'undone' ? (
        <div className="flex flex-col gap-1 text-body-sm text-text-2">
          <span>
            {t.t('duplicates.undone')}
            {merge.undoneAt === null ? null : (
              <>
                {' '}
                <When locale={locale} iso={merge.undoneAt} />
              </>
            )}
          </span>
          {merge.survivorReverted === false ? <span data-testid="merge-kept-edits">{t.t('duplicates.keptEdits')}</span> : null}
        </div>
      ) : null}
      {state === 'expired' ? <StatusPill tone="neutral">{t.t('duplicates.expired')}</StatusPill> : null}
    </li>
  );
}
