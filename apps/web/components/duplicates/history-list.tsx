'use client';

import type { Translator } from '@kasuwa/i18n/bundle';
import { SECONDARY_BUTTON } from '../auth/button-classes';
import type { ContactMerge } from '../../lib/duplicates-api';
import { mergeState } from './duplicates-model';
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
        <h2 id="merges-history-title" className="text-h3">
          {t.t('duplicates.history.title')}
        </h2>
        <p className="text-body-sm text-text-2">{t.t('duplicates.history.note')}</p>
      </div>
      {history.phase === 'loading' ? <Skeleton t={t} label="duplicates.history.loading" /> : null}
      {history.phase === 'error' ? (
        <p role="alert" data-testid="merges-failed" className="text-body-sm text-danger-text">
          {t.t('duplicates.history.failed')}
        </p>
      ) : null}
      {history.phase === 'loaded' && history.rows.length === 0 ? (
        <p data-testid="merges-empty" className="text-body-md text-text-2">
          {t.t('duplicates.history.empty')}
        </p>
      ) : null}
      {history.rows.length === 0 ? null : (
        <ul className="flex flex-col rounded-lg border border-border bg-surface">
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
    <li data-merge-row={merge.id} data-merge-state={state} className="flex flex-col gap-2 border-b border-border p-3 last:border-b-0">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-sm">
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
            <button type="button" data-merge-undo="" disabled={history.undoing !== null} onClick={() => history.undo(merge.id)} className={SECONDARY_BUTTON}>
              {t.t('duplicates.undo')}
            </button>
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
      {state === 'expired' ? <span className="text-body-sm text-text-2">{t.t('duplicates.expired')}</span> : null}
    </li>
  );
}
